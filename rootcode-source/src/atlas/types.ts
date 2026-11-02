export type NodeKind =
	| 'file' | 'class' | 'interface' | 'method' | 'function'
	| 'component' | 'service' | 'module' | 'directive' | 'pipe';

export type EdgeKind = 'calls' | 'imports' | 'inherits' | 'implements' | 'references' | 'injects';

export type Language = 'typescript' | 'python';

export interface AtlasNode {
	id: number;
	path: string;
	kind: NodeKind;
	name: string;
	qualifiedName: string;
	startLine: number;
	endLine: number;
	/** One-line declaration, e.g. `getUser(id: string): Promise<User>`; saves an LSP hover for the common case. */
	signature?: string;
}

export interface AtlasEdge {
	src: number;
	/** Null when the target is not a node in this repo (e.g. a decorator marker). */
	dst: number | null;
	/** Raw target as written / resolved ("<path>::<qualified name>", decorator name, bare name). */
	dstRef: string;
	kind: EdgeKind;
}

/**
 * A reference as written in a file: `name` is a local symbol or import binding,
 * `member` the method/property after it. Resolved against import bindings at link time.
 */
export interface RefRecord {
	name: string;
	member?: string;
}

export interface ExtractedSymbol {
	kind: NodeKind;
	name: string;
	qualifiedName: string;
	startLine: number;
	endLine: number;
	calls: RefRecord[];
	injects: RefRecord[];
	implements: RefRecord[];
	inherits: RefRecord[];
	references: string[];
	signature?: string;
}

export interface ImportBinding {
	local: string;
	imported: string;
	kind: 'named' | 'default' | 'namespace' | 'module';
}

export interface ExtractedImport {
	spec: string;
	/** Python relative-import depth (leading dots). */
	level?: number;
	bindings: ImportBinding[];
}

export interface Extraction {
	symbols: ExtractedSymbol[];
	imports: ExtractedImport[];
	lineCount: number;
	/** Source length in characters (used to budget context without reading the file). */
	size: number;
}

export interface FileDependencyGraph {
	/** `cluster` is filled in by `fileGraphWithClusters`. */
	nodes: { path: string; dir: string; symbols: number; imports: number; importedBy: number; cluster?: string }[];
	/** Import edges as [sourceIndex, targetIndex] into `nodes` (compact: big repos have tens of thousands). */
	edges: [number, number][];
	clusters?: { id: string; name: string; size: number; dependsOn: string[] }[];
	/** Cluster-level import counts as [sourceClusterIndex, targetClusterIndex, weight] into `clusters`. */
	clusterEdges?: [number, number, number][];
}

export type EntrySource = 'active-editor' | 'diagnostic' | 'git' | 'query' | 'package-main' | 'symbol' | 'stack-trace' | 'open-tab' | 'overview';

/** Where graph traversal starts. `priority` follows the doc's order: 1 (active editor) .. 5 (package main). */
export interface EntryPoint {
	path: string;
	source: EntrySource;
	/** 1 active editor .. 5 last resort; sources of similar strength share a level. */
	priority: number;
	line?: number;
	/** Qualified symbol name when the entry is a specific symbol (symbol mention). */
	symbol?: string;
	reason: string;
}

/** Traversal output, before scoring. */
export interface Candidate {
	path: string;
	/** Filled in only for files selected in `full` mode. */
	content: string;
	/** Characters of content that would be sent (capped). */
	size: number;
	/** How the file entered the set: as an entry point, or reached through an import edge. */
	source: EntrySource | 'imports' | 'importedBy' | 'cochange' | 'test';
	hopDistance: number;
	hasErrors: boolean;
	errorCount: number;
	recentlyChanged: boolean;
	/** 0 = uncommitted, 1.. = position in the recent-commit timeline; -1 when not recent. */
	gitRank: number;
	entryPriority: number;
	importedByCount: number;
	/** Symbols relevant to the entry points (the entry symbol and its direct callers/callees) living in this file. */
	focus?: { name: string; startLine: number; endLine: number }[];
	symbols: { name: string; kind: NodeKind; startLine: number; endLine: number; signature?: string }[];
}

export type ContextFeatures = Record<string, number>;

export interface ContextItem extends Candidate {
	score: number;
	features: ContextFeatures;
	/** `full` carries the file body; `focus` the relevant symbol bodies plus an outline of the rest; `outline` only signatures; `seen` was already sent earlier in this conversation and is unchanged. */
	mode: 'full' | 'focus' | 'outline' | 'seen';
	/** Added by the scorer's exploration slot, not by rank. */
	explored?: boolean;
	tokens: number;
}
