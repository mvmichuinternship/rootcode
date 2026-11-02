import * as ts from 'typescript';
import type { ExtractedImport, ExtractedSymbol, Extraction, ImportBinding, NodeKind, RefRecord } from '../types';

const DECORATOR_KIND: Record<string, NodeKind> = {
	Component: 'component',
	Injectable: 'service',
	NgModule: 'module',
	Directive: 'directive',
	Pipe: 'pipe',
};

function scriptKind(filePath: string): ts.ScriptKind {
	if (/\.tsx$/.test(filePath)) { return ts.ScriptKind.TSX; }
	if (/\.(ts|mts|cts)$/.test(filePath)) { return ts.ScriptKind.TS; }
	if (/\.jsx$/.test(filePath)) { return ts.ScriptKind.JSX; }
	return ts.ScriptKind.JS;
}

function isFnValue(n: ts.Node | undefined): n is ts.ArrowFunction | ts.FunctionExpression {
	return !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
}

export function extractTypeScript(text: string, filePath: string): Extraction {
	const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind(filePath));
	const symbols: ExtractedSymbol[] = [];
	const imports: ExtractedImport[] = [];
	const bindings = new Map<string, ImportBinding>();
	const isJsx = /\.(tsx|jsx)$/.test(filePath);

	const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
	const span = (n: ts.Node) => ({ startLine: line(n.getStart(sf)), endLine: line(n.getEnd()) });
	const stripQuotes = (s: string) => s.replace(/^['"`]|['"`]$/g, '');

	// ── imports (ES import, re-export, dynamic import(), require()) ──
	const collectImports = (node: ts.Node) => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const rec: ExtractedImport = { spec: node.moduleSpecifier.text, bindings: [] };
			const clause = node.importClause;
			if (clause?.name) { rec.bindings.push({ local: clause.name.text, imported: 'default', kind: 'default' }); }
			if (clause?.namedBindings) {
				if (ts.isNamespaceImport(clause.namedBindings)) {
					rec.bindings.push({ local: clause.namedBindings.name.text, imported: '*', kind: 'namespace' });
				} else {
					for (const s of clause.namedBindings.elements) {
						rec.bindings.push({ local: s.name.text, imported: (s.propertyName ?? s.name).text, kind: 'named' });
					}
				}
			}
			imports.push(rec);
			for (const b of rec.bindings) { bindings.set(b.local, b); }
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			imports.push({ spec: node.moduleSpecifier.text, bindings: [] });
		} else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
			const fn = node.expression;
			if (fn.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(fn) && fn.text === 'require')) {
				imports.push({ spec: stripQuotes(node.arguments[0].text), bindings: [] });
			}
		}
		ts.forEachChild(node, collectImports);
	};
	collectImports(sf);

	// ── helpers ──
	const typeName = (t: ts.TypeNode | ts.Expression | undefined): string | undefined => {
		if (!t) { return undefined; }
		if (ts.isTypeReferenceNode(t)) { return ts.isIdentifier(t.typeName) ? t.typeName.text : t.typeName.right.text; }
		if (ts.isExpressionWithTypeArguments(t)) { return typeName(t.expression); }
		if (ts.isIdentifier(t)) { return t.text; }
		if (ts.isPropertyAccessExpression(t)) { return t.name.text; }
		return undefined;
	};
	const refOf = (e: ts.Expression): RefRecord | undefined => {
		if (ts.isIdentifier(e)) { return { name: e.text }; }
		if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) { return { name: e.expression.text, member: e.name.text }; }
		return undefined;
	};
	const decoratorsOf = (n: ts.Node): { name: string; call?: ts.CallExpression }[] =>
		(ts.canHaveDecorators(n) ? ts.getDecorators(n) ?? [] : []).map(d => {
			const e = d.expression;
			if (ts.isCallExpression(e)) { return { name: ts.isIdentifier(e.expression) ? e.expression.text : e.expression.getText(sf), call: e }; }
			return { name: e.getText(sf) };
		});

	const collectCalls = (body: ts.Node | undefined, className: string | undefined, propTypes: Map<string, string>, own: string): RefRecord[] => {
		const out: RefRecord[] = [];
		if (!body) { return out; }
		const seen = new Set<string>();
		const add = (name: string, member?: string) => {
			const key = member ? `${name}.${member}` : name;
			if (!name || seen.has(key) || key === own) { return; }
			seen.add(key);
			out.push(member ? { name, member } : { name });
		};
		const walk = (n: ts.Node) => {
			if (ts.isNewExpression(n)) {
				const t = typeName(n.expression);
				if (t) { add(t); }
			} else if (ts.isCallExpression(n)) {
				const fn = n.expression;
				if (ts.isIdentifier(fn)) {
					if (fn.text !== 'require') { add(fn.text); }
				} else if (ts.isPropertyAccessExpression(fn)) {
					const obj = fn.expression;
					if (obj.kind === ts.SyntaxKind.ThisKeyword && className) {
						add(className, fn.name.text); // this.save()
					} else if (ts.isIdentifier(obj) && (bindings.has(obj.text) || /^[A-Z]/.test(obj.text))) {
						add(obj.text, fn.name.text); // Service.run() / ns.fn()
					} else if (ts.isPropertyAccessExpression(obj) && obj.expression.kind === ts.SyntaxKind.ThisKeyword) {
						const t = propTypes.get(obj.name.text); // this.svc.get()
						if (t) { add(t, fn.name.text); }
					}
				}
			}
			ts.forEachChild(n, walk);
		};
		walk(body);
		return out;
	};

	/** Declaration text up to (excluding) the body, decorators stripped and whitespace collapsed. */
	const signatureOf = (n: ts.Node, end: number): string => {
		const raw = sf.text.slice(n.getStart(sf), end).replace(/^(?:@[\w.]+(?:\([^)]*\))?\s*)+/, '');
		const s = raw.replace(/\s+/g, ' ').replace(/\s*(=>|=|\{)\s*$/, '').trim();
		return s.length > 200 ? s.slice(0, 197) + '...' : s;
	};
	const emptySym = (kind: NodeKind, name: string, qualifiedName: string, n: ts.Node, signature?: string): ExtractedSymbol => ({
		kind, name, qualifiedName, ...span(n), calls: [], injects: [], implements: [], inherits: [], references: [], signature,
	});

	const returnsJsx = (n: ts.Node): boolean => {
		let found = false;
		const walk = (x: ts.Node) => {
			if (found) { return; }
			if (ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x) || ts.isJsxFragment(x)) { found = true; return; }
			ts.forEachChild(x, walk);
		};
		walk(n);
		return found;
	};

	const handleFunction = (spanNode: ts.Node, name: string, fn: ts.FunctionLikeDeclaration) => {
		const sym = emptySym('function', name, name, spanNode, signatureOf(spanNode, fn.body ? fn.body.getStart(sf) : fn.getEnd()));
		if (isJsx && /^[A-Z]/.test(name) && returnsJsx(fn)) { sym.kind = 'component'; }
		sym.calls = collectCalls(fn.body, undefined, new Map(), name);
		symbols.push(sym);
	};

	const handleClass = (cls: ts.ClassLikeDeclaration, spanNode: ts.Node, nameOverride?: string) => {
		const name = cls.name?.text ?? nameOverride;
		if (!name) { return; }
		const sym = emptySym('class', name, name, spanNode, signatureOf(cls, cls.members.pos));
		for (const d of decoratorsOf(cls)) {
			if (DECORATOR_KIND[d.name]) { sym.kind = DECORATOR_KIND[d.name]; } else { sym.references.push(`@${d.name}`); }
		}
		for (const h of cls.heritageClauses ?? []) {
			for (const t of h.types) {
				const r = refOf(t.expression);
				if (r) { (h.token === ts.SyntaxKind.ExtendsKeyword ? sym.inherits : sym.implements).push(r); }
			}
		}
		// Property name -> type, for `this.svc.get()` call attribution; constructor params also become injects.
		const propTypes = new Map<string, string>();
		for (const m of cls.members) {
			if (ts.isConstructorDeclaration(m)) {
				for (const p of m.parameters) {
					const t = typeName(p.type);
					if (!t) { continue; }
					sym.injects.push({ name: t });
					if (ts.isIdentifier(p.name) && ts.getCombinedModifierFlags(p) !== ts.ModifierFlags.None) { propTypes.set(p.name.text, t); }
				}
			} else if (ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name)) {
				const t = typeName(m.type);
				if (t) { propTypes.set(m.name.text, t); }
				const init = m.initializer;
				if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'inject' && init.arguments[0]) {
					const r = refOf(init.arguments[0]);
					if (r) { sym.injects.push(r); propTypes.set(m.name.text, r.name); }
				}
			}
		}
		symbols.push(sym);
		for (const m of cls.members) {
			let mname: string | undefined;
			let fn: ts.FunctionLikeDeclaration | undefined;
			if (ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) {
				mname = m.name.getText(sf); fn = m;
			} else if (ts.isConstructorDeclaration(m)) {
				mname = 'constructor'; fn = m;
			} else if (ts.isPropertyDeclaration(m) && isFnValue(m.initializer)) {
				mname = m.name.getText(sf); fn = m.initializer;
			}
			if (!mname || !fn) { continue; }
			const q = `${name}.${mname}`;
			const msym = emptySym('method', mname, q, m, signatureOf(m, fn.body ? fn.body.getStart(sf) : m.getEnd()));
			msym.calls = collectCalls(fn.body, name, propTypes, q);
			for (const d of decoratorsOf(m)) { msym.references.push(`@${d.name}`); }
			symbols.push(msym);
		}
	};

	const visit = (container: ts.Node) => {
		ts.forEachChild(container, child => {
			if (ts.isClassDeclaration(child)) {
				handleClass(child, child);
			} else if (ts.isInterfaceDeclaration(child)) {
				const sym = emptySym('interface', child.name.text, child.name.text, child, signatureOf(child, child.members.pos));
				for (const h of child.heritageClauses ?? []) {
					for (const t of h.types) {
						const r = refOf(t.expression);
						if (r) { sym.inherits.push(r); }
					}
				}
				symbols.push(sym);
			} else if (ts.isFunctionDeclaration(child) && child.name) {
				handleFunction(child, child.name.text, child);
			} else if (ts.isVariableStatement(child)) {
				for (const d of child.declarationList.declarations) {
					if (!ts.isIdentifier(d.name) || !d.initializer) { continue; }
					if (isFnValue(d.initializer)) { handleFunction(child, d.name.text, d.initializer); }
					else if (ts.isClassExpression(d.initializer)) { handleClass(d.initializer, child, d.name.text); }
				}
			} else if (ts.isModuleDeclaration(child) && child.body) {
				visit(child.body);
			} else if (ts.isModuleBlock(child)) {
				visit(child);
			}
		});
	};
	visit(sf);

	return { symbols, imports, lineCount: sf.getLineAndCharacterOfPosition(sf.end).line + 1, size: text.length };
}
