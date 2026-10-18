import * as vscode from 'vscode';
import { Logger } from 'winston';
import { FailedCheckovCheck } from './checkov';
import { DisplayLevel, displayLevel, meetsMinimumSeverity, SeverityMappings } from './severity';

export const diagnosticSource = 'Checkov ';

const diagnosticSeverities: Record<DisplayLevel, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    information: vscode.DiagnosticSeverity.Information
};

export interface DiagnosticReferenceCode {
    target: vscode.Uri;
    value: string;
}

// Returns the number of findings hidden by the minimum severity filter.
export const applyDiagnostics = (document: vscode.TextDocument, diagnostics: vscode.DiagnosticCollection, failedCheckovChecks: FailedCheckovCheck[],
    severityMappings: Pick<SeverityMappings, 'resolve'>, logger?: Logger, minimumSeverity = 'None'): number => {
    const foundDiagnostics: vscode.Diagnostic[] = [];
    let hidden = 0;

    for (const failure of failedCheckovChecks) {
        const line = document.lineAt(failure.fileLineRange[0] > 0 ? failure.fileLineRange[0] - 1 : 0); // checkov results are 1-based; these lines are 0-based
        const startPos = line.range.start.translate({ characterDelta: line.firstNonWhitespaceCharacterIndex });
        const code: DiagnosticReferenceCode | string =
            failure.guideline?.startsWith('http') ?
                {
                    target: vscode.Uri.parse(failure.guideline),
                    value: failure.checkId
                } : `${failure.checkId}${failure.guideline ? `: ${failure.guideline}` : ''}`;

        const severityString = severityMappings.resolve(failure.checkId, failure.severity);

        if (logger) {
            logger.debug(`Processing ${failure.checkId}: original severity=${failure.severity}, mapped severity=${severityString}`);
        }

        if (!meetsMinimumSeverity(severityString, minimumSeverity)) {
            hidden++;
            continue;
        }

        // Create message with severity prefix
        const severityPrefix = `[${severityString.toUpperCase()}] `;
        const message = `${severityPrefix}${failure.checkName}`;

        foundDiagnostics.push({
            message,
            range: new vscode.Range(startPos, line.range.end),
            severity: diagnosticSeverities[displayLevel(severityString)],
            source: diagnosticSource,
            code
        });
    }

    diagnostics.set(document.uri ,foundDiagnostics);
    return hidden;
};
