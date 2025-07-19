import * as vscode from 'vscode';
import { Logger } from 'winston';
import { FailedCheckovCheck } from './checkov';
import { getSeverityForCheckId, mapSeverityToVSCode } from './utils';

export interface DiagnosticReferenceCode {
    target: vscode.Uri;
    value: string;
}

export const applyDiagnostics = (document: vscode.TextDocument, diagnostics: vscode.DiagnosticCollection, failedCheckovChecks: FailedCheckovCheck[], logger?: Logger): void => {
    const foundDiagnostics: vscode.Diagnostic[] = [];

    for (const failure of failedCheckovChecks) {
        const line = document.lineAt(failure.fileLineRange[0] > 0 ? failure.fileLineRange[0] - 1 : 0); // checkov results are 1-based; these lines are 0-based
        const startPos = line.range.start.translate({ characterDelta: line.firstNonWhitespaceCharacterIndex });
        const code: DiagnosticReferenceCode | string =
            failure.guideline?.startsWith('http') ?
                {
                    target: vscode.Uri.parse(failure.guideline),
                    value: failure.checkId
                } : `${failure.checkId}${failure.guideline ? `: ${failure.guideline}` : ''}`;

        // Get severity from mapping first, then fallback to failure.severity, then to MEDIUM
        let severityString = getSeverityForCheckId(failure.checkId, logger);
        if (!severityString) {
            severityString = failure.severity || 'MEDIUM';
        }

        if (logger) {
            logger.debug(`Processing ${failure.checkId}: original severity=${failure.severity}, mapped severity=${severityString}`);
        }

        // Map severity to VS Code diagnostic severity
        const vsSeverity = mapSeverityToVSCode(severityString);

        // Create message with severity prefix
        const severityPrefix = `[${severityString.toUpperCase()}] `;
        const message = `${severityPrefix}${failure.checkName}`;

        foundDiagnostics.push({
            message,
            range: new vscode.Range(startPos, line.range.end),
            severity: vsSeverity,
            source: 'Checkov ',
            code
        });
    }

    diagnostics.set(document.uri ,foundDiagnostics);
};
