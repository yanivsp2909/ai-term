// Only the React primitives this tiny shell uses. No JSX or React event types are needed.
declare module 'react' {
  export function createElement(type: string | (() => unknown), props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
  export function useEffect(effect: () => void | (() => void), deps: readonly unknown[]): void;
  export function useRef<T>(initial: T): { current: T };
  export function useState<T>(initial: T): [T, (value: T) => void];
}
declare module 'react-dom/client' {
  export function createRoot(container: Element): { render(element: unknown): void };
}
