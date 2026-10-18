import type { Memento } from 'vscode';
import { Clock } from '../../clock';

export const settle = () => new Promise(resolve => setImmediate(resolve));

export class ManualClock implements Clock {
    private time = Date.UTC(2026, 9, 18, 12);
    private nextId = 0;
    private readonly timers = new Map<number, { at: number, callback: () => void }>();

    setTimeout(callback: () => void, ms: number): number {
        this.nextId++;
        this.timers.set(this.nextId, { at: this.time + ms, callback });
        return this.nextId;
    }

    clearTimeout(handle: unknown): void {
        this.timers.delete(handle as number);
    }

    now(): number {
        return this.time;
    }

    async advance(ms: number): Promise<void> {
        const target = this.time + ms;
        while (true) {
            const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort(([, a], [, b]) => a.at - b.at)[0];
            if (!due) break;
            const [id, timer] = due;
            this.timers.delete(id);
            this.time = timer.at;
            timer.callback();
            await settle();
        }
        this.time = target;
        await settle();
    }
}

// Returns copies so a caller that mutates a value without calling update() loses the change, as a persisted Memento would.
export class InMemoryMemento implements Memento {
    private readonly values = new Map<string, string>();

    keys(): readonly string[] {
        return [...this.values.keys()];
    }

    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string, defaultValue?: T): T | undefined {
        const value = this.values.get(key);
        return value === undefined ? defaultValue : JSON.parse(value);
    }

    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.values.delete(key);
        } else {
            this.values.set(key, JSON.stringify(value));
        }
    }
}
