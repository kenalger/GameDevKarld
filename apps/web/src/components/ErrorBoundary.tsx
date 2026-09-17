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
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Local only. Nothing about the ROM or the error leaves the device.
    console.error('WebBoy crashed:', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="error" role="alert">
        <strong>The emulator stopped unexpectedly.</strong>
        <p style={{ margin: '6px 0' }}>{error.message}</p>
        <div className="transport">
          <button type="button" onClick={this.props.onExportState}>
            Export save state
          </button>
          <button type="button" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
