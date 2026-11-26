// FAST_BABEL: @babel/parser (with its estree plugin) parses the files that esprima 4 and esprima-next reject:
// TypeScript, Flow, JSX, decorators and the newest syntax. This pass removes what main.js cannot convert, keeping the
// positions of the source; modernize.js then rewrites the ES2018-ES2022 nodes that remain.
//   type-only declarations and imports/exports    removed (interface, type, declare, abstract members, overloads,
//                                                 import type, export type, Flow declare/opaque types)
//   e as T, e satisfies T, e!, <T>e, (e: T), e<T> e
//   annotations, type parameters, modifiers       removed fields
//   enum E { A, B = 5 }                           var E = {A: 0, B: 5} (a member without a literal initializer: its
//                                                 index)
//   namespace N { ... } (not declare)             its statements, in a block
//   constructor(private x)                        the parameter x, and this.x = x at the start of the constructor
//   import x = require('m'), export = e           var x = require('m'), module.exports = e
//   @decorator                                    removed
//   <Tag a={v} {...p}>{e}</Tag>                   React.createElement(Tag, {a: v, ...p}, e) (a lowercase tag is a string)
//   #!... (interpreter directive)                 removed
'use strict';

const SKIP = new Set(['loc', 'range', 'start', 'end', 'leadingComments', 'trailingComments', 'innerComments', 'comments',
    'tokens', 'errors', 'extra']);
const REMOVE = Symbol('remove');

function at(place, node) {
    node.loc = place.loc;
    node.range = place.range;
    return node;
}

// a node that the source does not hold: its text is its own (getCode in main.js)
function ident(name, place) {
    return at(place, { type: 'Identifier', name: name, syntheticCode: name });
}

function literal(value, place) {
    return at(place, { type: 'Literal', value: value, raw: JSON.stringify(value), syntheticCode: JSON.stringify(value) });
}

function member(object, name, place) {
    return at(place, { type: 'MemberExpression', computed: false, object: object, property: ident(name, place) });
}

const TYPE_ONLY = new Set([
    'TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction', 'TSNamespaceExportDeclaration',
    'TSIndexSignature', 'TSDeclareMethod', 'TSAbstractMethodDefinition', 'TSAbstractPropertyDefinition',
    'TSAbstractAccessorProperty',
    'TypeAlias', 'OpaqueType', 'InterfaceDeclaration', 'DeclareVariable', 'DeclareFunction', 'DeclareClass',
    'DeclareModule', 'DeclareModuleExports', 'DeclareTypeAlias', 'DeclareOpaqueType', 'DeclareInterface',
    'DeclareExportDeclaration', 'DeclareExportAllDeclaration', 'DeclareEnum',
]);
const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion',
    'TSInstantiationExpression', 'TypeCastExpression']);
const TYPE_FIELDS = ['typeAnnotation', 'returnType', 'typeParameters', 'typeArguments', 'superTypeParameters',
    'superTypeArguments', 'implements', 'predicate', 'decorators', 'accessibility', 'declare', 'abstract', 'override',
    'readonly', 'definite', 'variance'];
const PATTERNS = new Set(['Identifier', 'ObjectPattern', 'ArrayPattern', 'AssignmentPattern', 'RestElement']);

function isTypeOnly(n) {
    if (TYPE_ONLY.has(n.type)) return true;
    if (n.declare) return true;  // declare const/class/function/module, declare fields
    if (n.abstract && (n.type === 'MethodDefinition' || n.type === 'PropertyDefinition')) return true;
    if (n.type === 'MethodDefinition' && n.value && !n.value.body) return true;  // method overload signature
    if (n.type === 'TSModuleDeclaration' && !n.body) return true;
    if ((n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') &&
        (n.importKind === 'type' || n.importKind === 'typeof' || n.exportKind === 'type')) return true;
    if ((n.type === 'ExportNamedDeclaration' || n.type === 'ExportDefaultDeclaration') && n.declaration &&
        isTypeOnly(n.declaration)) return true;
    return false;
}

function jsxName(n, place) {
    switch (n.type) {
        case 'JSXIdentifier':
            return /^[a-z]/.test(n.name) || n.name.includes('-') ? literal(n.name, n) : at(n, { type: 'Identifier', name: n.name });
        case 'JSXMemberExpression':
            return at(n, { type: 'MemberExpression', computed: false, object: jsxName(n.object, place),
                property: at(n.property, { type: 'Identifier', name: n.property.name }) });
        case 'JSXNamespacedName':
            return literal(n.namespace.name + ':' + n.name.name, n);
        default:
            return lower(n);
    }
}

function jsxChildren(children) {
    const out = [];
    for (const c of children) {
        if (c.type === 'JSXText') {
            const text = c.value.replace(/\s+/g, ' ').trim();
            if (text) out.push(literal(text, c));
        } else if (c.type === 'JSXExpressionContainer') {
            if (c.expression.type !== 'JSXEmptyExpression') out.push(lower(c.expression));
        } else if (c.type === 'JSXSpreadChild') {
            out.push(lower(c.expression));
        } else {
            out.push(lower(c));
        }
    }
    return out;
}

function jsxElement(n) {
    const react = ident('React', n);
    const tag = n.type === 'JSXFragment' ? member(react, 'Fragment', n) : jsxName(n.openingElement.name, n);
    const attrs = n.type === 'JSXFragment' ? [] : n.openingElement.attributes;
    const props = attrs.length === 0 ? literal(null, n) : at(n, { type: 'ObjectExpression', properties: attrs.map(a => {
        if (a.type === 'JSXSpreadAttribute') return at(a, { type: 'SpreadElement', argument: lower(a.argument) });
        const key = a.name.type === 'JSXNamespacedName' ? literal(a.name.namespace.name + ':' + a.name.name.name, a.name)
            : literal(a.name.name, a.name);
        let value = a.value === null ? literal(true, a) : a.value.type === 'JSXExpressionContainer'
            ? (a.value.expression.type === 'JSXEmptyExpression' ? literal(true, a) : lower(a.value.expression)) : lower(a.value);
        return at(a, { type: 'Property', key: key, computed: false, value: value, kind: 'init', method: false, shorthand: false });
    }) });
    return at(n, { type: 'CallExpression', callee: member(react, 'createElement', n), optional: false,
        arguments: [tag, props, ...jsxChildren(n.children)] });
}

function enumObject(n) {
    let index = 0;
    const props = n.members.map(m => {
        let value;
        if (m.initializer && m.initializer.type === 'Literal') {
            value = m.initializer;
            if (typeof m.initializer.value === 'number') index = m.initializer.value + 1;
        } else if (m.initializer) {
            value = lower(m.initializer);
        } else {
            value = literal(index++, m);
        }
        const key = m.id.type === 'Identifier' ? m.id : literal(m.id.value, m.id);
        return at(m, { type: 'Property', key: key, computed: false, value: value, kind: 'init', method: false, shorthand: false });
    });
    return at(n, { type: 'VariableDeclaration', kind: 'var', declarations: [at(n, { type: 'VariableDeclarator', id: n.id,
        init: at(n, { type: 'ObjectExpression', properties: props }) })] });
}

// constructor(private x, public y = 1): plain parameters, and this.x = x; this.y = y at the start of the body
function parameterProperties(fn) {
    const assigns = [];
    fn.params = fn.params.map(p => {
        if (p.type !== 'TSParameterProperty') return p;
        const param = p.parameter;
        const id = param.type === 'AssignmentPattern' ? param.left : param;
        if (id.type === 'Identifier') {
            const target = at(p, { type: 'MemberExpression', computed: false, object: at(p, { type: 'ThisExpression', syntheticCode: 'this' }),
                property: ident(id.name, id) });
            assigns.push(at(p, { type: 'ExpressionStatement', expression: at(p, { type: 'AssignmentExpression', operator: '=',
                left: target, right: ident(id.name, id) }) }));
        }
        return param;
    });
    if (assigns.length && fn.body && fn.body.body) {
        const stmts = fn.body.body;
        const i = stmts.findIndex(s => s.type === 'ExpressionStatement' && s.expression.type === 'CallExpression' &&
            s.expression.callee.type === 'Super');
        stmts.splice(i + 1, 0, ...assigns);
    }
}

function lower(node) {
    if (Array.isArray(node)) return node.map(lower).filter(n => n !== REMOVE);
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return node;
    if (isTypeOnly(node)) return REMOVE;
    if (WRAPPERS.has(node.type)) return lower(node.expression);
    switch (node.type) {
        case 'JSXElement': case 'JSXFragment':
            return jsxElement(node);
        case 'TSEnumDeclaration':
            return enumObject(node);
        case 'TSModuleDeclaration': {  // a namespace with code: its statements in a block
            let body = node.body;
            while (body && body.type === 'TSModuleDeclaration') body = body.body;
            return at(node, { type: 'BlockStatement', body: lower(body ? body.body : []) });
        }
        case 'TSImportEqualsDeclaration': {
            if (node.importKind === 'type') return REMOVE;
            const ref = node.moduleReference;
            const init = ref.type === 'TSExternalModuleReference'
                ? at(ref, { type: 'CallExpression', callee: ident('require', ref), arguments: [ref.expression], optional: false })
                : lower(tsEntityName(ref));
            return at(node, { type: 'VariableDeclaration', kind: 'var',
                declarations: [at(node, { type: 'VariableDeclarator', id: node.id, init: init })] });
        }
        case 'TSExportAssignment':
            return at(node, { type: 'ExpressionStatement', expression: at(node, { type: 'AssignmentExpression', operator: '=',
                left: member(ident('module', node), 'exports', node), right: lower(node.expression) }) });
        case 'ImportDeclaration':
            node.specifiers = node.specifiers.filter(s => s.importKind !== 'type' && s.importKind !== 'typeof');
            break;
        case 'ExportNamedDeclaration':
            node.specifiers = node.specifiers.filter(s => s.exportKind !== 'type');
            if (!node.declaration && node.specifiers.length === 0 && !node.source) return REMOVE;
            break;
        case 'Program':
            delete node.interpreter;
            break;
    }
    // Babel's range of an identifier includes its annotation (a: string, a?): its text is its name
    if (node.type === 'Identifier') node.syntheticCode = node.name;
    if (node.type === 'MethodDefinition' && node.kind === 'constructor' && node.value) parameterProperties(node.value);
    for (const f of TYPE_FIELDS) delete node[f];
    if (PATTERNS.has(node.type)) delete node.optional;
    for (const k of Object.keys(node)) {
        if (!SKIP.has(k)) {
            const v = lower(node[k]);
            if (v === REMOVE) delete node[k]; else node[k] = v;
        }
    }
    return node;
}

// A.B.C of import x = A.B.C, as member expressions
function tsEntityName(n) {
    if (n.type === 'TSQualifiedName') return at(n, { type: 'MemberExpression', computed: false, object: tsEntityName(n.left), property: n.right });
    return n;
}

module.exports = lower;
