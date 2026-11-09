/** A deliberate failure whose message is safe to send to the browser. */
export class ChatError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502) {
    super(message)
    this.name = 'ChatError'
  }
}
