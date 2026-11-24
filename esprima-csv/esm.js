// FAST_ESM: FAST follows require() and module.exports only. This pass rewrites the ES module syntax of a program into
// that CommonJS, so that FAST loads the modules a file imports and sees what it exports:
//   import x from 's'                var x = require('s').default || require('s')
//   import {a as b} from 's'         var b = require('s').a
//   import * as ns from 's'          var ns = require('s')
//   import 's'                       require('s')
//   export function f() {} / export const x = ... / export class C {}
//                                    the declaration, then module.exports.f = f (each declared name)
//   export {a as b}                  module.exports.b = a
//   export {a as b} from 's'         module.exports.b = require('s').a
//   export * from 's'                Object.assign(module.exports, require('s'))
//   export * as ns from 's'          module.exports.ns = require('s')
//   export default v                 module.exports.default = v, and module.exports = v when the module exports no
//                                    names, so that FAST's module mode (-m) runs an exported default function
//   import('s')                      require('s') (also the call of `import` that modernize.js makes of it)
// The bindings are copies, not live; the imports stay where they are written, not hoisted.
'use strict';

const SKIP = new Set(['loc', 'range', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'errors']);

function at(place, node) {
    node.loc = place.loc;
    node.range = place.range;
    return node;
}

// an identifier that the source does not hold: its text is its name (getCode in main.js)
function ident(name, place) {
    return at(place, { type: 'Identifier', name: name, syntheticCode: name });
}

function member(object, name, place) {
    return at(place, { type: 'MemberExpression', computed: false, object: object, property: ident(name, place) });
}

function moduleExports(place) {
    return member(ident('module', place), 'exports', place);
}

function requireCall(source, place) {
    return at(place, { type: 'CallExpression', callee: ident('require', place), arguments: [source] });
}

function statement(expression, place) {
    return at(place, { type: 'ExpressionStatement', expression: expression });
}

function assign(left, right, place) {
    return statement(at(place, { type: 'AssignmentExpression', operator: '=', left: left, right: right }), place);
}

function declare(name, init, place) {
    return at(place, { type: 'VariableDeclaration', kind: 'var',
        declarations: [at(place, { type: 'VariableDeclarator', id: ident(name, place), init: init })] });
}

function exportName(spec) {
    return spec.type === 'Literal' ? String(spec.value) : spec.name;
}

// the names a declaration binds: the id of a function or class, the identifiers of the patterns of a var declaration
function declaredNames(decl) {
    if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') return decl.id ? [decl.id.name] : [];
    const names = [];
    (function collect(p) {
        if (!p) return;
        switch (p.type) {
            case 'Identifier': names.push(p.name); break;
            case 'ObjectPattern': p.properties.forEach(q => collect(q.type === 'RestElement' ? q.argument : q.value)); break;
            case 'ArrayPattern': p.elements.forEach(collect); break;
            case 'AssignmentPattern': collect(p.left); break;
            case 'RestElement': collect(p.argument); break;
        }
    })({ type: 'ArrayPattern', elements: (decl.declarations || []).map(d => d.id) });
    return names;
}

// one ES module statement as CommonJS statements; null when it is no module statement
function lowerStatement(s, onlyDefault) {
    switch (s.type) {
        case 'ImportDeclaration': {
            if (s.specifiers.length === 0) return [statement(requireCall(s.source, s), s)];
            return s.specifiers.map(sp => {
                const req = requireCall(s.source, sp);
                if (sp.type === 'ImportDefaultSpecifier') {
                    return declare(sp.local.name, at(sp, { type: 'LogicalExpression', operator: '||',
                        left: member(req, 'default', sp), right: requireCall(s.source, sp) }), sp);
                }
                if (sp.type === 'ImportNamespaceSpecifier') return declare(sp.local.name, req, sp);
                const name = exportName(sp.imported);
                return declare(sp.local.name, name === 'default'
                    ? at(sp, { type: 'LogicalExpression', operator: '||', left: member(req, 'default', sp), right: requireCall(s.source, sp) })
                    : member(req, name, sp), sp);
            });
        }
        case 'ExportNamedDeclaration': {
            if (s.declaration) {
                return [s.declaration, ...declaredNames(s.declaration).map(n =>
                    assign(member(moduleExports(s), n, s), ident(n, s), s))];
            }
            return s.specifiers.map(sp => {
                const value = s.source ? (exportName(sp.local) === 'default'
                    ? member(requireCall(s.source, sp), 'default', sp)
                    : member(requireCall(s.source, sp), exportName(sp.local), sp)) : sp.local;
                return assign(member(moduleExports(sp), exportName(sp.exported), sp), value, sp);
            });
        }
        case 'ExportAllDeclaration': {
            if (s.exported) return [assign(member(moduleExports(s), exportName(s.exported), s), requireCall(s.source, s), s)];
            return [statement(at(s, { type: 'CallExpression', callee: member(ident('Object', s), 'assign', s),
                arguments: [moduleExports(s), requireCall(s.source, s)] }), s)];
        }
        case 'ExportDefaultDeclaration': {
            const d = s.declaration;
            const out = [];
            let value;
            if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) {
                out.push(d);
                value = () => ident(d.id.name, s);
            } else if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') {
                // an anonymous default function or class: the same as an expression
                const expr = Object.assign({}, d, { type: d.type === 'FunctionDeclaration' ? 'FunctionExpression' : 'ClassExpression' });
                out.push(declare('__default_export', expr, s));
                value = () => ident('__default_export', s);
            } else {
                out.push(declare('__default_export', d, s));
                value = () => ident('__default_export', s);
            }
            if (onlyDefault) out.push(assign(moduleExports(s), value(), s));
            out.push(assign(member(moduleExports(s), 'default', s), value(), s));
            return out;
        }
        default:
            return null;
    }
}

// import(s), and the call of `import` that modernize.js makes of it
function lowerImportCalls(node) {
    if (Array.isArray(node)) return node.map(lowerImportCalls);
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return node;
    for (const k of Object.keys(node)) {
        if (!SKIP.has(k)) node[k] = lowerImportCalls(node[k]);
    }
    if (node.type === 'ImportExpression') return requireCall(node.source, node);
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'import' &&
        node.callee.syntheticCode === 'import') {
        return requireCall(node.arguments[0], node);
    }
    return node;
}

module.exports = function esm(root) {
    lowerImportCalls(root);
    const onlyDefault = root.body.some(s => s.type === 'ExportDefaultDeclaration') &&
        !root.body.some(s => s.type === 'ExportNamedDeclaration' || s.type === 'ExportAllDeclaration');
    root.body = root.body.flatMap(s => lowerStatement(s, onlyDefault) || [s]);
    return root;
};
