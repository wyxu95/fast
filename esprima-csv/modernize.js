// FAST_MODERN_PARSER: esprima-next parses the ES2018-ES2022 syntax that esprima 4 rejects. This pass rewrites the node
// types that esprima 4 never produces into the shapes that main.js already converts, so the conversion stays as it is:
//   a?.b, a?.(b)       ChainExpression -> its member or call expression (`optional` is ignored)
//   a ?? b             LogicalExpression '??' -> '||'
//   catch { }          CatchClause without a parameter -> a parameter _catch_param
//   #x, this.#x        PrivateIdentifier -> Identifier '#x'
//   import(x)          ImportExpression -> a call of the identifier `import` (no module is loaded)
//   class field x = v  a Property in a class body (esprima-next's PropertyDefinition): a function value -> a method x;
//                      any other value of an instance field -> `this.x = v` in the constructor, after its super()
//                      call; a static field without a function value is dropped
//   static { ... }     StaticBlock -> a static method __static_block
//   {...a, b: 1}       an object literal with spread -> Object.assign({}, a, {b: 1})
//   {c, ...r} = o      a rest element of an object pattern -> the property r (r gets o.r, not the other properties)
//   [, b] = a          a hole of an array pattern -> the identifier _hole (main.js's addParam reads the name of each
//                      element of a destructured parameter, and stops on a hole)
// The rest of the new syntax parses into node types that esprima 4 already has. ES modules (import/export
// declarations) are converted as before.
'use strict';

const SKIP = new Set(['loc', 'range', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'errors']);

// a new node at the place of `at`
function at(at, node) {
    node.loc = at.loc;
    node.range = at.range;
    return node;
}

// an identifier that the source does not hold: its text is its name (getCode in main.js)
function ident(name, place) {
    return at(place, { type: 'Identifier', name: name, syntheticCode: name });
}

function asFunction(f) {
    if (f.type === 'FunctionExpression') return f;
    const body = f.body.type === 'BlockStatement' ? f.body
        : at(f.body, { type: 'BlockStatement', body: [at(f.body, { type: 'ReturnStatement', argument: f.body })] });
    return at(f, { type: 'FunctionExpression', id: null, params: f.params, body: body, generator: false,
        async: f.async, expression: false });
}

function method(key, computed, isStatic, kind, fn, place) {
    return at(place, { type: 'MethodDefinition', key: key, computed: computed, static: isStatic, kind: kind, value: fn });
}

function isSuperCall(s) {
    return s.type === 'ExpressionStatement' && s.expression.type === 'CallExpression' && s.expression.callee.type === 'Super';
}

// the class fields and static blocks of a class (ClassDeclaration or ClassExpression), its children already lowered
function lowerClass(cls) {
    const body = cls.body, out = [], inits = [];
    for (const m of body.body) {
        if (m.type === 'Property' || m.type === 'PropertyDefinition') {
            const v = m.value;
            if (v && (v.type === 'ArrowFunctionExpression' || v.type === 'FunctionExpression')) {
                out.push(method(m.key, m.computed, m.static, 'method', asFunction(v), m));
            } else if (v && !m.static) {
                const target = at(m, { type: 'MemberExpression', computed: m.computed, object: at(m, { type: 'ThisExpression', syntheticCode: 'this' }),
                    property: m.key });
                inits.push(at(m, { type: 'ExpressionStatement',
                    expression: at(m, { type: 'AssignmentExpression', operator: '=', left: target, right: v }) }));
            }
        } else if (m.type === 'StaticBlock') {
            const block = at(m, { type: 'BlockStatement', body: m.body });
            out.push(method(ident('__static_block', m), false, true, 'method',
                at(m, { type: 'FunctionExpression', id: null, params: [], body: block, generator: false, async: false,
                    expression: false }), m));
        } else {
            out.push(m);
        }
    }
    if (inits.length) {
        let ctor = out.find(m => m.type === 'MethodDefinition' && m.kind === 'constructor');
        if (!ctor) {
            // the implicit constructor: constructor(...args) { super(...args); }
            const args = ident('args', body);
            const stmts = cls.superClass ? [at(body, { type: 'ExpressionStatement', expression: at(body, {
                type: 'CallExpression', callee: at(body, { type: 'Super' }), arguments: [at(body, { type: 'SpreadElement', argument: ident('args', body) })] }) })] : [];
            ctor = method(ident('constructor', body), false, false, 'constructor', at(body, { type: 'FunctionExpression',
                id: null, params: cls.superClass ? [at(body, { type: 'RestElement', argument: args })] : [],
                body: at(body, { type: 'BlockStatement', body: stmts }), generator: false, async: false, expression: false }), body);
            out.unshift(ctor);
        }
        const stmts = ctor.value.body.body;
        const i = stmts.findIndex(isSuperCall);
        stmts.splice(i + 1, 0, ...inits);
    }
    body.body = out;
}

function lower(node) {
    if (Array.isArray(node)) {
        return node.map(lower);
    }
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return node;
    for (const k of Object.keys(node)) {
        if (!SKIP.has(k)) node[k] = lower(node[k]);
    }
    switch (node.type) {
        case 'ChainExpression':
            return node.expression;
        case 'LogicalExpression':
            if (node.operator === '??') node.operator = '||';
            return node;
        case 'CatchClause':
            if (!node.param) node.param = ident('_catch_param', node);
            return node;
        case 'PrivateIdentifier':
            return at(node, { type: 'Identifier', name: '#' + node.name });
        case 'ImportExpression':
            return at(node, { type: 'CallExpression', callee: ident('import', node), arguments: [node.source] });
        case 'ObjectExpression': {
            if (!node.properties.some(p => p.type === 'SpreadElement')) return node;
            const args = [at(node, { type: 'ObjectExpression', properties: [] })];
            let run = null;
            for (const p of node.properties) {
                if (p.type === 'SpreadElement') {
                    run = null;
                    args.push(p.argument);
                } else {
                    if (!run) args.push(run = at(p, { type: 'ObjectExpression', properties: [] }));
                    run.properties.push(p);
                }
            }
            const assign = at(node, { type: 'MemberExpression', computed: false, object: ident('Object', node),
                property: ident('assign', node) });
            return at(node, { type: 'CallExpression', callee: assign, arguments: args });
        }
        case 'ArrayPattern':
            node.elements = node.elements.map(e => e === null ? ident('_hole', node) : e);
            return node;
        case 'ObjectPattern':
            node.properties = node.properties.map(p => p.type !== 'RestElement' ? p : at(p, { type: 'Property',
                key: p.argument, computed: false, value: p.argument, kind: 'init', method: false, shorthand: true }));
            return node;
        case 'ClassDeclaration':
        case 'ClassExpression':
            lowerClass(node);
            return node;
        default:
            return node;
    }
}

module.exports = lower;
