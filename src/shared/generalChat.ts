// Android's quick prompt uses the same folder on its SSH host.
export const GENERAL_CHAT_FOLDER = 'legal-terminal-general'

export const isGeneralChatDirectory = (path?: string): boolean =>
  path?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() === GENERAL_CHAT_FOLDER
