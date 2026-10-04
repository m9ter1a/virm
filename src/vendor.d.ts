// toasted-notifier ships no types. Only what virm uses.
declare module "toasted-notifier" {
  interface Notifier {
    notify(options: Record<string, unknown>, callback?: (err: Error | null, response?: unknown, metadata?: unknown) => void): unknown;
  }
  const notifier: Notifier;
  export = notifier;
}
