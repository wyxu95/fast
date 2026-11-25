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
//
// FAST_ESM_LAZY: an import loads its module where the code uses the imported name, as a require() inside a function
// does. The import declaration goes away, and each reference to an imported name becomes its require() expression:
//   x  (import x from 's')           (require('s').default || require('s'))
//   b  (import {a as b} from 's')    require('s').a
//   ns (import * as ns from 's')     require('s')
// so FAST loads 's' only when it runs code that uses the name. Names that a scope declares again (parameters, var,
// let, const, function and class declarations, catch parameters) are not references to the import, nor are property
// names, object keys, method names, labels and assignment targets. import 's' (no names) stays a require() where it is.
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

// --- FAST_ESM_LAZY ---------------------------------------------------------------------------------------------

function bindingNames(p, out) {
    if (!p) return out;
    switch (p.type) {
        case 'Identifier': out.add(p.name); break;
        case 'ObjectPattern': p.properties.forEach(q => bindingNames(q.type === 'RestElement' ? q.argument : q.value, out)); break;
        case 'ArrayPattern': p.elements.forEach(e => bindingNames(e, out)); break;
        case 'AssignmentPattern': bindingNames(p.left, out); break;
        case 'RestElement': bindingNames(p.argument, out); break;
    }
    return out;
}

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

// the var declarations and nested function declarations of a function body, not those of nested functions
function varNames(node, out) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach(n => varNames(n, out)); return out; }
    if (typeof node.type !== 'string') return out;
    if (node.type === 'VariableDeclaration' && node.kind === 'var') node.declarations.forEach(d => bindingNames(d.id, out));
    if (FUNCTIONS.has(node.type) || node.type === 'ClassDeclaration' || node.type === 'ClassExpression') return out;
    for (const k of Object.keys(node)) {
        if (!SKIP.has(k)) varNames(node[k], out);
    }
    return out;
}

// the let, const, class and function declarations directly in a statement list
function blockNames(stmts, out) {
    for (const s of stmts || []) {
        if (s.type === 'VariableDeclaration' && s.kind !== 'var') s.declarations.forEach(d => bindingNames(d.id, out));
        if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id) out.add(s.id.name);
    }
    return out;
}

function lazify(root, bindings) {
    const shadowed = (shadow, names) => {
        const hit = [...names].filter(n => bindings.has(n) && !shadow.has(n));
        return hit.length ? new Set([...shadow, ...hit]) : shadow;
    };
    const reference = (id) => {
        const b = bindings.get(id.name);
        const req = requireCall(Object.assign({}, b.source), id);
        if (b.kind === 'namespace') return req;
        if (b.kind === 'default') {
            return at(id, { type: 'LogicalExpression', operator: '||', left: member(req, 'default', id),
                right: requireCall(Object.assign({}, b.source), id) });
        }
        return member(req, b.name, id);
    };
    const isRef = (n, shadow) => n && n.type === 'Identifier' && bindings.has(n.name) && !shadow.has(n.name);

    // a binding position (declaration or assignment target): only its default values and computed keys are expressions
    function pattern(p, shadow) {
        if (!p) return p;
        switch (p.type) {
            case 'ObjectPattern':
                p.properties.forEach(q => {
                    if (q.type === 'RestElement') q.argument = pattern(q.argument, shadow);
                    else { if (q.computed) q.key = expr(q.key, shadow); q.value = pattern(q.value, shadow); }
                });
                return p;
            case 'ArrayPattern': p.elements = p.elements.map(e => pattern(e, shadow)); return p;
            case 'AssignmentPattern': p.left = pattern(p.left, shadow); p.right = expr(p.right, shadow); return p;
            case 'RestElement': p.argument = pattern(p.argument, shadow); return p;
            case 'MemberExpression': return expr(p, shadow);
            default: return p;  // an identifier being bound
        }
    }

    function fn(f, shadow) {
        const names = new Set();
        f.params.forEach(p => bindingNames(p, names));
        if (f.type === 'FunctionExpression' && f.id) names.add(f.id.name);
        if (f.body.type === 'BlockStatement') { varNames(f.body.body, names); blockNames(f.body.body, names); }
        const inner = shadowed(shadow, names);
        f.params = f.params.map(p => pattern(p, inner));
        if (f.body.type === 'BlockStatement') f.body.body = f.body.body.map(s => expr(s, inner));
        else f.body = expr(f.body, inner);
        return f;
    }

    function expr(node, shadow) {
        if (!node || typeof node !== 'object') return node;
        if (Array.isArray(node)) return node.map(n => expr(n, shadow));
        if (typeof node.type !== 'string') return node;
        switch (node.type) {
            case 'Identifier':
                return isRef(node, shadow) ? reference(node) : node;
            case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
                return fn(node, shadow);
            case 'ClassDeclaration': case 'ClassExpression': {
                const inner = node.type === 'ClassExpression' && node.id ? shadowed(shadow, [node.id.name]) : shadow;
                node.superClass = expr(node.superClass, inner);
                node.body = expr(node.body, inner);
                return node;
            }
            case 'BlockStatement': {
                const inner = shadowed(shadow, blockNames(node.body, new Set()));
                node.body = node.body.map(s => expr(s, inner));
                return node;
            }
            case 'SwitchStatement': {
                node.discriminant = expr(node.discriminant, shadow);
                const inner = shadowed(shadow, blockNames(node.cases.flatMap(c => c.consequent), new Set()));
                node.cases = node.cases.map(c => { c.test = expr(c.test, inner); c.consequent = c.consequent.map(s => expr(s, inner)); return c; });
                return node;
            }
            case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': {
                const head = node.type === 'ForStatement' ? node.init : node.left;
                const inner = head && head.type === 'VariableDeclaration' && head.kind !== 'var'
                    ? shadowed(shadow, head.declarations.reduce((o, d) => bindingNames(d.id, o), new Set())) : shadow;
                for (const k of ['init', 'test', 'update', 'right', 'body']) if (k in node) node[k] = expr(node[k], inner);
                if (node.type !== 'ForStatement') node.left = node.left.type === 'VariableDeclaration' ? expr(node.left, inner) : pattern(node.left, inner);
                return node;
            }
            case 'CatchClause': {
                const inner = shadowed(shadow, bindingNames(node.param, new Set()));
                node.param = pattern(node.param, inner);
                node.body = expr(node.body, inner);
                return node;
            }
            case 'VariableDeclarator':
                node.id = pattern(node.id, shadow);
                node.init = expr(node.init, shadow);
                return node;
            case 'AssignmentExpression':
                node.left = node.left.type === 'Identifier' ? node.left : pattern(node.left, shadow);
                node.right = expr(node.right, shadow);
                return node;
            case 'UpdateExpression':
                if (node.argument.type !== 'Identifier') node.argument = expr(node.argument, shadow);
                return node;
            case 'MemberExpression':
                node.object = expr(node.object, shadow);
                if (node.computed) node.property = expr(node.property, shadow);
                return node;
            case 'Property': case 'MethodDefinition': case 'PropertyDefinition':
                if (node.computed) node.key = expr(node.key, shadow);
                if (node.shorthand && isRef(node.value, shadow)) node.shorthand = false;
                node.value = expr(node.value, shadow);
                return node;
            case 'LabeledStatement':
                node.body = expr(node.body, shadow);
                return node;
            case 'BreakStatement': case 'ContinueStatement':
                return node;
            case 'ExportSpecifier':  // export {b}: the value exported is the import's (made by lowerStatement)
                if (isRef(node.local, shadow)) node.local = reference(node.local);
                return node;
            default:
                for (const k of Object.keys(node)) {
                    if (!SKIP.has(k)) node[k] = expr(node[k], shadow);
                }
                return node;
        }
    }

    root.body = root.body.map(s => s.type === 'ExportNamedDeclaration' && s.source ? s : expr(s, new Set()));
}

// the import declarations with names as lazy bindings (local name -> source and kind), removed from the program
function takeImports(root) {
    const bindings = new Map();
    root.body = root.body.filter(s => {
        if (s.type !== 'ImportDeclaration' || s.specifiers.length === 0) return true;
        for (const sp of s.specifiers) {
            if (sp.type === 'ImportDefaultSpecifier') bindings.set(sp.local.name, { source: s.source, kind: 'default' });
            else if (sp.type === 'ImportNamespaceSpecifier') bindings.set(sp.local.name, { source: s.source, kind: 'namespace' });
            else {
                const name = exportName(sp.imported);
                bindings.set(sp.local.name, name === 'default' ? { source: s.source, kind: 'default' }
                    : { source: s.source, kind: 'named', name: name });
            }
        }
        return false;
    });
    return bindings;
}

module.exports = function esm(root, lazy) {
    lowerImportCalls(root);
    if (lazy) {
        const bindings = takeImports(root);
        if (bindings.size) lazify(root, bindings);
    }
    const onlyDefault = root.body.some(s => s.type === 'ExportDefaultDeclaration') &&
        !root.body.some(s => s.type === 'ExportNamedDeclaration' || s.type === 'ExportAllDeclaration');
    root.body = root.body.flatMap(s => lowerStatement(s, onlyDefault) || [s]);
    return root;
};
