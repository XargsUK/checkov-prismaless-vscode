import * as vscode from 'vscode';
import { FailedCheckovCheck } from './checkov';
import { OPEN_EXTERNAL_COMMAND, REMOVE_DIAGNOSTICS_COMMAND } from './commands';
import { DisplayLevel, displayLevel, meetsMinimumSeverity, SeverityMappings } from './severity';

const diagnosticSource = 'Checkov ';

const diagnosticSeverities: Record<DisplayLevel, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    information: vscode.DiagnosticSeverity.Information
};

export const providedCodeActionKinds: vscode.CodeActionKind[] = [
    vscode.CodeActionKind.QuickFix,
    vscode.CodeActionKind.Empty
];

export interface Findings {
    publish(document: vscode.TextDocument, findings: FailedCheckovCheck[], minimumSeverity: string): { hidden: number };
    clear(uri: vscode.Uri): void;
    codeActions(document: vscode.TextDocument, diagnostics: readonly vscode.Diagnostic[]): vscode.CodeAction[];
}

export interface FindingsDependencies {
    collection: vscode.DiagnosticCollection;
    severityMappings: Pick<SeverityMappings, 'resolve'>;
}

interface PublishedFinding {
    diagnostic: vscode.Diagnostic;
    finding: FailedCheckovCheck;
}

// Checkov reports 1-based line ranges, and line 0 for findings about the whole file.
const lineSpan = (document: vscode.TextDocument, finding: FailedCheckovCheck): { first: number, last: number } => {
    const clamp = (line: number) => Math.min(Math.max(line, 0), document.lineCount - 1);
    const first = clamp(finding.fileLineRange[0] - 1);
    return { first, last: Math.max(first, clamp(finding.fileLineRange[1] - 1)) };
};

const guidelineUrl = (finding: FailedCheckovCheck): vscode.Uri | undefined =>
    finding.guideline && /^https?:\/\//i.test(finding.guideline) ? vscode.Uri.parse(finding.guideline) : undefined;

const codeValue = (code: vscode.Diagnostic['code']): string | number | undefined =>
    typeof code === 'object' ? code.value : code;

const isSameDiagnostic = (a: vscode.Diagnostic, b: vscode.Diagnostic): boolean =>
    a.range.isEqual(b.range) && a.message === b.message && codeValue(a.code) === codeValue(b.code);

const createDiagnostic = (document: vscode.TextDocument, finding: FailedCheckovCheck, severity: string): vscode.Diagnostic => {
    const line = document.lineAt(lineSpan(document, finding).first);
    const url = guidelineUrl(finding);
    return {
        message: `[${severity.toUpperCase()}] ${finding.checkName}`,
        range: new vscode.Range(line.range.start.translate({ characterDelta: line.firstNonWhitespaceCharacterIndex }), line.range.end),
        severity: diagnosticSeverities[displayLevel(severity)],
        source: diagnosticSource,
        code: url ? { value: finding.checkId, target: url } : `${finding.checkId}${finding.guideline ? `: ${finding.guideline}` : ''}`
    };
};

const commentPrefixes: Record<string, string> = {
    ts: '//',
    js: '//',
    go: '//',
    java: '//',
    cpp: '//',
    cc: '//',
    cs: '//',
    php: '//',
    swift: '//'
};

const skipComment = (checkId: string, fileName: string, indentation: string): string =>
    `${indentation}${commentPrefixes[fileName.split('.').pop() ?? ''] ?? '#'} checkov:skip=${checkId}: ADD REASON\n`;

const leadingWhitespace = (line: vscode.TextLine): string =>
    line.isEmptyOrWhitespace ? '  ' : line.text.slice(0, line.firstNonWhitespaceCharacterIndex);

const codeActionsFor = (document: vscode.TextDocument, diagnostic: vscode.Diagnostic, finding: FailedCheckovCheck): vscode.CodeAction[] => {
    const { first, last } = lineSpan(document, finding);
    const actions: vscode.CodeAction[] = [];

    // A finding for the whole file reports line 0, which gives no range for a fix to replace.
    if (finding.fixedDefinition && finding.fileLineRange[0] > 0) {
        const fixEdit = new vscode.WorkspaceEdit();
        fixEdit.replace(document.uri, new vscode.Range(document.lineAt(first).range.start, document.lineAt(last).range.end), finding.fixedDefinition);
        actions.push({
            title: `Apply fix for - ${finding.checkName}`,
            kind: vscode.CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            isPreferred: true,
            edit: fixEdit,
            command: { title: 'Apply fix', command: REMOVE_DIAGNOSTICS_COMMAND }
        });
    }

    // Kubernetes checks are skipped with annotations, not comments.
    if (!finding.checkId.includes('_K8S_')) {
        // Checkov only honours a skip comment inside the resource block, so it goes after the block's first line.
        const skipLine = document.lineAt(Math.min(first + 1, document.lineCount - 1));
        const skipEdit = new vscode.WorkspaceEdit();
        skipEdit.insert(document.uri, skipLine.range.start, skipComment(finding.checkId, document.fileName, leadingWhitespace(skipLine)));
        actions.push({
            title: `Generate skip comment for - ${finding.checkName}`,
            kind: vscode.CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            isPreferred: false,
            edit: skipEdit,
            command: { title: 'Generate skip comment', command: REMOVE_DIAGNOSTICS_COMMAND }
        });
    }

    const url = guidelineUrl(finding);
    if (url) {
        actions.push({
            title: `Learn more about - ${finding.checkName}`,
            kind: vscode.CodeActionKind.Empty,
            diagnostics: [diagnostic],
            command: { title: 'See more at Bridgecrew', command: OPEN_EXTERNAL_COMMAND, arguments: [url] }
        });
    }

    return actions;
};

export const createFindings = ({ collection, severityMappings }: FindingsDependencies): Findings => {
    const published = new Map<string, PublishedFinding[]>();

    return {
        publish: (document, findings, minimumSeverity) => {
            const shown: PublishedFinding[] = [];
            for (const finding of findings) {
                const severity = severityMappings.resolve(finding.checkId, finding.severity);
                if (meetsMinimumSeverity(severity, minimumSeverity)) {
                    shown.push({ finding, diagnostic: createDiagnostic(document, finding, severity) });
                }
            }
            published.set(document.uri.toString(), shown);
            collection.set(document.uri, shown.map(item => item.diagnostic));
            return { hidden: findings.length - shown.length };
        },
        // Also clears files inside the URI, so a deleted or renamed folder takes its files' findings with it.
        clear: uri => {
            const target = uri.toString();
            for (const key of [...published.keys()].filter(key => key === target || key.startsWith(`${target}/`))) {
                published.delete(key);
                collection.delete(vscode.Uri.parse(key));
            }
            collection.delete(uri);
        },
        // VS Code passes copies of the diagnostics, so they are matched by value rather than by identity,
        // and identical diagnostics are paired with identical findings in order.
        codeActions: (document, diagnostics) => {
            const items = published.get(document.uri.toString()) ?? [];
            const ours = diagnostics.filter(diagnostic => diagnostic.source === diagnosticSource);
            return ours.flatMap((diagnostic, index) => {
                const occurrence = ours.slice(0, index).filter(earlier => isSameDiagnostic(earlier, diagnostic)).length;
                const match = items.filter(item => isSameDiagnostic(item.diagnostic, diagnostic))[occurrence];
                return match ? codeActionsFor(document, diagnostic, match.finding) : [];
            });
        }
    };
};
