export class ClientSignal extends Error {
  constructor(readonly exitCode: number) { super('Client interrupted'); }
}
