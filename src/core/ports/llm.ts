export type JsonSchema = { [key: string]: unknown };

export interface JsonRequest {
  system: string;
  user: string;
  // Plain JSON schema: an object with every property required and additionalProperties false,
  // which both Workers AI JSON mode and Claude structured outputs accept
  schema: JsonSchema;
  maxTokens: number;
}

// A model that answers with JSON matching a schema. Workers AI or Claude behind it.
export interface LlmClient {
  // Provider and model, for logs
  readonly name: string;
  generateJson(request: JsonRequest): Promise<unknown>;
}
