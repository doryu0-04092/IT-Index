/** 特定のAIプロバイダに依存しない、チャット往復の共通契約 */
export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  system?: string;
  messages: AiMessage[];
}

export interface AiClient {
  send(request: AiRequest): Promise<string>;
}
