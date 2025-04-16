import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export function run(): Promise<void> {
    // Create the mocha test
    const mocha = new Mocha({
        ui: 'tdd',
        color: true
    });

    const testsRoot = path.resolve(__dirname, '..');

    return glob('**/**.test.js', { cwd: testsRoot })
        .then((files: string[]) => {
            files.forEach((f: string) => mocha.addFile(path.resolve(testsRoot, f)));
            return new Promise<void>((c, e) => {
                try {
                    mocha.run((failures: number) => {
                        if (failures > 0) {
                            e(new Error(`${failures} tests failed.`));
                        } else {
                            c();
                        }
                    });
                } catch (err) {
                    console.error(err);
                    e(err instanceof Error ? err : new Error(String(err)));
                }
            });
        })
        .catch((err) => {
            throw err instanceof Error ? err : new Error(String(err));
        });
}
