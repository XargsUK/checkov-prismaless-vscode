import * as assert from 'assert';
import { meetsMinimumSeverity, resolveSeverity } from '../../severityFilter';

suite('meetsMinimumSeverity', () => {
    test('shows everything when no minimum is set', () => {
        assert.ok(meetsMinimumSeverity('INFO', 'None'));
        assert.ok(meetsMinimumSeverity('INFO', 'none'));
        assert.ok(meetsMinimumSeverity('LOW', ''));
    });

    test('hides findings below the minimum', () => {
        assert.ok(!meetsMinimumSeverity('LOW', 'MEDIUM'));
        assert.ok(!meetsMinimumSeverity('INFO', 'LOW'));
        assert.ok(!meetsMinimumSeverity('HIGH', 'CRITICAL'));
    });

    test('shows findings at or above the minimum', () => {
        assert.ok(meetsMinimumSeverity('MEDIUM', 'MEDIUM'));
        assert.ok(meetsMinimumSeverity('CRITICAL', 'HIGH'));
        assert.ok(meetsMinimumSeverity('HIGH', 'Medium'));
        assert.ok(!meetsMinimumSeverity('LOW', 'Medium'));
        assert.ok(meetsMinimumSeverity('high', 'medium'));
    });

    test('never hides a finding with an unknown severity', () => {
        assert.ok(meetsMinimumSeverity('UNKNOWN', 'CRITICAL'));
        assert.ok(meetsMinimumSeverity('', 'CRITICAL'));
    });
});

suite('resolveSeverity', () => {
    test('prefers the severity mapping', () => {
        assert.strictEqual(resolveSeverity('HIGH', 'LOW'), 'HIGH');
    });

    test('falls back to the severity Checkov reported', () => {
        assert.strictEqual(resolveSeverity(undefined, 'LOW'), 'LOW');
    });

    test('is UNKNOWN when neither source has a severity', () => {
        assert.strictEqual(resolveSeverity(undefined, undefined), 'UNKNOWN');
        assert.strictEqual(resolveSeverity(undefined, ''), 'UNKNOWN');
    });

    test('lets the minimum severity hide an unmapped check Checkov reported as low', () => {
        assert.ok(!meetsMinimumSeverity(resolveSeverity(undefined, 'LOW'), 'MEDIUM'));
        assert.ok(meetsMinimumSeverity(resolveSeverity(undefined, undefined), 'CRITICAL'));
    });
});
