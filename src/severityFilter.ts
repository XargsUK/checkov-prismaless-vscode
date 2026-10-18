const severityOrder = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

// Severities that are not in the list (UNKNOWN, custom policies) are always shown,
// so a finding is never hidden just because its severity could not be resolved.
export const meetsMinimumSeverity = (severity: string, minimumSeverity: string): boolean => {
    const minimum = severityOrder.indexOf(minimumSeverity.toUpperCase());
    const actual = severityOrder.indexOf(severity.toUpperCase());
    return minimum === -1 || actual === -1 || actual >= minimum;
};

export const resolveSeverity = (mapped: string | null | undefined, reported: string | undefined): string =>
    mapped || reported || 'UNKNOWN';
