import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { FailedCheckovCheck } from '../../checkov/models';
import { OPEN_EXTERNAL_COMMAND, REMOVE_DIAGNOSTICS_COMMAND } from '../../commands';
import { createFindings, Findings } from '../../findings';

const bucket = (name: string) => `resource "aws_s3_bucket" "${name}" {\n  bucket = "${name}"\n}\n`;

const finding = (overrides: Partial<FailedCheckovCheck> = {}): FailedCheckovCheck => ({
    checkId: 'CKV_AWS_18',
    checkName: 'Ensure the S3 bucket has access logging enabled',
    fileLineRange: [1, 3],
    resource: 'aws_s3_bucket.a',
    severity: 'MEDIUM',
    ...overrides
});

const openDocument = (content: string) => vscode.workspace.openTextDocument({ content, language: 'terraform' });

// Diagnostics reach the code action context asynchronously after collection.set, so retry until they arrive.
const codeActionsFor = async (document: vscode.TextDocument, diagnostic: vscode.Diagnostic): Promise<vscode.CodeAction[]> => {
    const checkName = diagnostic.message.replace(/^\[\w+\] /, '');
    for (let attempt = 0; attempt < 40; attempt++) {
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', document.uri, diagnostic.range) ?? [];
        if (actions.some(action => action.title.endsWith(` - ${checkName}`))) {
            return actions;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`No code actions arrived for "${checkName}"`);
};

const editsFor = (action: vscode.CodeAction | undefined, document: vscode.TextDocument) =>
    action?.edit?.get(document.uri).map(edit => ({
        start: [edit.range.start.line, edit.range.start.character],
        end: [edit.range.end.line, edit.range.end.character],
        newText: edit.newText
    }));

suite('findings for a document', () => {
    let collection: vscode.DiagnosticCollection;
    let documentFindings: Findings;
    let registration: vscode.Disposable;

    setup(() => {
        collection = vscode.languages.createDiagnosticCollection('checkov-findings-test');
        documentFindings = createFindings({ collection, severityMappings: { resolve: (_checkId, reported) => reported ?? 'UNKNOWN' } });
        registration = vscode.languages.registerCodeActionsProvider({ pattern: '**' }, {
            provideCodeActions: (document, _range, context) => documentFindings.codeActions(document, context.diagnostics)
        });
    });

    teardown(() => {
        registration.dispose();
        collection.dispose();
    });

    test('a quick fix on one file applies that file\'s fix, even after another file is published', async () => {
        const first = await openDocument(bucket('a'));
        const second = await openDocument(bucket('b'));
        documentFindings.publish(first, [finding({ fixedDefinition: 'fixed a\n' })], 'None');
        documentFindings.publish(second, [finding({ fixedDefinition: 'fixed b\n' })], 'None');

        const [diagnostic] = collection.get(first.uri) ?? [];
        const fix = (await codeActionsFor(first, diagnostic)).find(action => action.title.startsWith('Apply fix'));

        assert.deepStrictEqual(editsFor(fix, first), [{ start: [0, 0], end: [2, 1], newText: 'fixed a\n' }]);
    });

    test('the skip comment goes inside the resource block and the fix replaces the resource lines', async () => {
        const document = await openDocument(`variable "x" {}\n${bucket('a')}`);
        documentFindings.publish(document, [finding({ fileLineRange: [2, 4], fixedDefinition: 'fixed\n' })], 'None');

        const [diagnostic] = collection.get(document.uri) ?? [];
        const actions = await codeActionsFor(document, diagnostic);

        assert.strictEqual(diagnostic.range.start.line, 1);
        assert.deepStrictEqual(editsFor(actions.find(action => action.title.startsWith('Apply fix')), document),
            [{ start: [1, 0], end: [3, 1], newText: 'fixed\n' }]);
        assert.deepStrictEqual(editsFor(actions.find(action => action.title.startsWith('Generate skip comment')), document),
            [{ start: [2, 0], end: [2, 0], newText: '  # checkov:skip=CKV_AWS_18: ADD REASON\n' }]);
    });

    test('a finding for the whole file (line 0) offers a skip comment but no fix, since its range is unknown', async () => {
        const document = await openDocument(bucket('a'));
        documentFindings.publish(document, [finding({ fileLineRange: [0, 0], fixedDefinition: 'fixed\n' })], 'None');

        const [diagnostic] = collection.get(document.uri) ?? [];
        const actions = await codeActionsFor(document, diagnostic);

        assert.strictEqual(diagnostic.range.start.line, 0);
        assert.ok(!actions.some(action => action.title.startsWith('Apply fix')));
        assert.deepStrictEqual(editsFor(actions.find(action => action.title.startsWith('Generate skip comment')), document),
            [{ start: [1, 0], end: [1, 0], newText: '  # checkov:skip=CKV_AWS_18: ADD REASON\n' }]);
    });

    test('applying a fix or skip comment clears the findings of the document it was applied to', async () => {
        const document = await openDocument(bucket('a'));
        documentFindings.publish(document, [finding({ fixedDefinition: 'fixed\n' })], 'None');

        const [diagnostic] = collection.get(document.uri) ?? [];
        const actions = (await codeActionsFor(document, diagnostic))
            .filter(action => action.title.startsWith('Apply fix') || action.title.startsWith('Generate skip comment'));

        assert.strictEqual(actions.length, 2);
        for (const action of actions) {
            assert.strictEqual(action.command?.command, REMOVE_DIAGNOSTICS_COMMAND, action.title);
            assert.strictEqual(action.command?.arguments?.[0]?.toString(), document.uri.toString(), action.title);
        }
    });

    test('the skip comment matches the indentation of the block it goes into', async () => {
        const document = await openDocument('Resources:\n  Bucket:\n    Type: AWS::S3::Bucket\n');
        documentFindings.publish(document, [finding({ fileLineRange: [2, 3] })], 'None');

        const [diagnostic] = collection.get(document.uri) ?? [];
        const skip = (await codeActionsFor(document, diagnostic)).find(action => action.title.startsWith('Generate skip comment'));

        assert.deepStrictEqual(editsFor(skip, document), [{ start: [2, 0], end: [2, 0], newText: '    # checkov:skip=CKV_AWS_18: ADD REASON\n' }]);
    });

    test('two identical diagnostics each get their own finding\'s fix', async () => {
        const document = await openDocument(bucket('a'));
        documentFindings.publish(document, [finding({ fixedDefinition: 'first\n' }), finding({ fixedDefinition: 'second\n' })], 'None');

        const [diagnostic] = collection.get(document.uri) ?? [];
        const fixes = (await codeActionsFor(document, diagnostic))
            .filter(action => action.title.startsWith('Apply fix'))
            .map(action => editsFor(action, document)?.[0].newText);

        assert.deepStrictEqual(fixes.sort(), ['first\n', 'second\n']);
    });

    test('Kubernetes findings are not offered a skip comment', async () => {
        const document = await openDocument('apiVersion: v1\nkind: Pod\n');
        documentFindings.publish(document, [finding({ checkId: 'CKV_K8S_8', fileLineRange: [1, 2], fixedDefinition: 'fixed\n' })], 'None');

        const [diagnostic] = collection.get(document.uri) ?? [];
        const titles = (await codeActionsFor(document, diagnostic)).map(action => action.title);

        assert.ok(titles.some(title => title.startsWith('Apply fix')), titles.join(', '));
        assert.ok(!titles.some(title => title.startsWith('Generate skip comment')), titles.join(', '));
    });

    test('"Learn more" is only offered for a guideline that is a web link, and opens it', async () => {
        const document = await openDocument(`${bucket('a')}${bucket('b')}`);
        documentFindings.publish(document, [
            finding({ checkName: 'linked', guideline: 'https://docs.prismacloud.io/ckv-aws-18' }),
            finding({ checkName: 'unlinked', fileLineRange: [4, 6], guideline: 'Enable access logging' })
        ], 'None');

        const [linked, unlinked] = collection.get(document.uri) ?? [];
        const learnMore = (await codeActionsFor(document, linked)).find(action => action.title === 'Learn more about - linked');
        const unlinkedTitles = (await codeActionsFor(document, unlinked)).map(action => action.title);

        assert.strictEqual(learnMore?.command?.command, OPEN_EXTERNAL_COMMAND);
        assert.strictEqual(learnMore?.command?.arguments?.[0]?.toString(), 'https://docs.prismacloud.io/ckv-aws-18');
        assert.ok(!unlinkedTitles.some(title => title.startsWith('Learn more')), unlinkedTitles.join(', '));
    });

    test('findings below the minimum severity are hidden and counted', async () => {
        const document = await openDocument(`${bucket('a')}${bucket('b')}`);
        const { hidden } = documentFindings.publish(document, [
            finding({ checkName: 'low', severity: 'LOW' }),
            finding({ checkName: 'high', fileLineRange: [4, 6], severity: 'HIGH' })
        ], 'Medium');

        assert.strictEqual(hidden, 1);
        assert.deepStrictEqual(collection.get(document.uri)?.map(diagnostic => [diagnostic.message, diagnostic.severity]),
            [['[HIGH] high', vscode.DiagnosticSeverity.Error]]);
    });

    test('clearing one file leaves the other file\'s findings and quick fixes in place', async () => {
        const first = await openDocument(bucket('a'));
        const second = await openDocument(bucket('b'));
        documentFindings.publish(first, [finding()], 'None');
        documentFindings.publish(second, [finding({ fixedDefinition: 'fixed b\n' })], 'None');

        documentFindings.clear(first.uri);

        assert.deepStrictEqual(collection.get(first.uri), []);
        const [diagnostic] = collection.get(second.uri) ?? [];
        assert.ok((await codeActionsFor(second, diagnostic)).some(action => action.title.startsWith('Apply fix')));
    });

    test('clearing a folder clears the findings of every file inside it', async () => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'checkov-findings-'));
        const inside = path.join(folder, 'main.tf');
        const outside = `${folder}-sibling.tf`;
        fs.writeFileSync(inside, bucket('a'));
        fs.writeFileSync(outside, bucket('b'));
        try {
            const insideDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(inside));
            const outsideDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(outside));
            documentFindings.publish(insideDocument, [finding()], 'None');
            documentFindings.publish(outsideDocument, [finding()], 'None');

            documentFindings.clear(vscode.Uri.file(folder));

            assert.deepStrictEqual(collection.get(insideDocument.uri), []);
            assert.strictEqual(collection.get(outsideDocument.uri)?.length, 1);
        } finally {
            fs.rmSync(folder, { recursive: true, force: true });
            fs.rmSync(outside, { force: true });
        }
    });
});
