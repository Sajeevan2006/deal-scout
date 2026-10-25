// Mirrors the subset of Cloudflare D1 we use, so env.DB can drop in later
export type SqlValue = string | number | null;

export interface RunResult {
  success: boolean;
  meta: {
    changes: number;
    last_row_id: number;
  };
}

export interface AllResult<Row> {
  results: Row[];
  success: boolean;
}

export interface PreparedStatement {
  bind(...values: SqlValue[]): PreparedStatement;
  first<Row = Record<string, unknown>>(): Promise<Row | null>;
  all<Row = Record<string, unknown>>(): Promise<AllResult<Row>>;
  run(): Promise<RunResult>;
}

export interface Database {
  prepare(sql: string): PreparedStatement;
}
