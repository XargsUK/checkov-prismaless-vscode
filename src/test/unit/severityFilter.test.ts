import * as assert from 'assert';
import { meetsMinimumSeverity } from '../../severityFilter';

suite('meetsMinimumSeverity', () => {
    test('shows everything when no minimum is set', () => {
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
        assert.ok(meetsMinimumSeverity('high', 'medium'));
    });

    test('never hides a finding with an unknown severity', () => {
        assert.ok(meetsMinimumSeverity('UNKNOWN', 'CRITICAL'));
        assert.ok(meetsMinimumSeverity('', 'CRITICAL'));
    });
});
