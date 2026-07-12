import fs from 'node:fs';

export type ExportFormat = 'csv' | 'jsonl';

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (value instanceof Date) {
    text = value.toISOString();
  } else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    text = value.toString();
  } else {
    text = JSON.stringify(value) ?? '';
  }
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function csvLine(values: unknown[]): string {
  return `${values.map(csvEscape).join(',')}\n`;
}

export function jsonlLine(row: Record<string, unknown>): string {
  return `${JSON.stringify(row)}\n`;
}

/**
 * Incremental file writer with backpressure: write() resolves only after the
 * OS accepted the chunk (drain-aware), keeping memory flat on large exports.
 */
export class FileExportWriter {
  private readonly stream: fs.WriteStream;
  private headerWritten = false;

  constructor(
    filePath: string,
    private readonly format: ExportFormat,
  ) {
    this.stream = fs.createWriteStream(filePath, { flags: 'w', encoding: 'utf8' });
  }

  async writeRow(row: Record<string, unknown>, columnNames: string[]): Promise<void> {
    if (this.format === 'csv' && !this.headerWritten) {
      this.headerWritten = true;
      await this.write(csvLine(columnNames));
    }
    const line = this.format === 'csv' ? csvLine(columnNames.map((name) => row[name])) : jsonlLine(row);
    await this.write(line);
  }

  /** Writes the CSV header even when the result has zero rows. */
  async finalize(columnNames: string[]): Promise<void> {
    if (this.format === 'csv' && !this.headerWritten && columnNames.length > 0) {
      this.headerWritten = true;
      await this.write(csvLine(columnNames));
    }
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }

  async abort(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.stream.destroy();
      resolve();
    });
  }

  private write(chunk: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      // destroy()/abort() emits 'close' without 'drain' — settle instead of hanging.
      const onClose = () => {
        cleanup();
        reject(new Error('export stream closed before the write drained'));
      };
      const cleanup = () => {
        this.stream.off('drain', onDrain);
        this.stream.off('error', onError);
        this.stream.off('close', onClose);
      };
      const ok = this.stream.write(chunk, (err) => {
        if (err) return; // surfaced via the 'error' listener
        if (ok) {
          cleanup();
          resolve();
        }
      });
      if (!ok) {
        this.stream.once('drain', onDrain);
        this.stream.once('error', onError);
        this.stream.once('close', onClose);
      }
    });
  }
}
