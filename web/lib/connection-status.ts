import { z } from 'zod';

export const connectionCheckSchema = z.object({
  provider: z.enum(['openai', 'claude', 'gemini']),
  key: z.string().trim().min(1).max(1024).regex(/^[!-~]+$/),
  model: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
}).strict();

export const connectionMessages = {
  saved: 'Saved key unavailable or your account changed. Reload saved connections or sign in again.',
  checked: 'Access checked. The provider accepted your key and returned model details.',
  invalid: 'Enter an API key and a valid model ID, then check again.',
  signin: 'Sign in again before checking access.',
  origin: 'Reload Trio and try again.',
  credentials: 'The provider rejected access. Check your API key and its permissions in the provider console.',
  geminiKey: 'Google rejected this API key as invalid. Copy a Gemini API key from Google AI Studio, paste it into the Gemini API key field, then check access and save the replacement. A Gemini subscription does not supply an API key.',
  model: 'This model was not found or is unavailable to this key. Check the model ID and your provider account.',
  limited: 'The provider is limiting requests. Check your account limits and try again later.',
  rejected: 'The provider could not check this key and model. Check both values and your account restrictions.',
  unavailable: 'The provider is temporarily unavailable. Try again shortly.',
  unreadable: 'The provider returned unexpected model details. Try again or check the model ID.',
  timeout: 'The access check timed out. Try again.',
  cancelled: 'Access check cancelled.',
  network: 'Could not reach the provider. Check your connection and try again.',
} as const;
export type ConnectionStatus = keyof typeof connectionMessages;
