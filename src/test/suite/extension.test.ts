import * as assert from 'assert';
import * as vscode from 'vscode';

suite('extension', () => {
    test('activates and registers every command it contributes', async () => {
        const extension = vscode.extensions.getExtension('XargsUK.checkov-prismaless');
        assert.ok(extension, 'extension is installed in the test host');
        await extension.activate();

        const contributed: string[] = extension.packageJSON.contributes.commands.map((command: { command: string }) => command.command);
        const registered = await vscode.commands.getCommands(true);

        assert.ok(contributed.length > 0);
        assert.deepStrictEqual(contributed.filter(command => !registered.includes(command)), []);
    });
});
