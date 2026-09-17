import { Component, type ErrorInfo, type ReactNode } from 'react';
interface Props {
    children: ReactNode;
    onExportState: () => void;
}
interface State {
    error: Error | null;
}
/**
 * Catches a crash in the emulator surface.
 *
 * An unhandled error must never leave a blank screen. It also must not cost the player
 * their progress, so the fallback offers a state export before anything is reset.
 */
export declare class ErrorBoundary extends Component<Props, State> {
    state: State;
    static getDerivedStateFromError(error: Error): State;
    componentDidCatch(error: Error, info: ErrorInfo): void;
    render(): ReactNode;
}
export {};
//# sourceMappingURL=ErrorBoundary.d.ts.map