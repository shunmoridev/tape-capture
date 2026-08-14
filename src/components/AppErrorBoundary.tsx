import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: string | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(cause: unknown): State {
    return { error: String(cause) };
  }

  componentDidCatch(cause: unknown, info: ErrorInfo): void {
    console.error("TapeCapture UI failed", cause, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="ui-recovery" role="alert">
        <h1>表示画面を再読み込みできます</h1>
        <p>録画・監視は専用のキャプチャ画面で継続します。下のボタンで操作画面だけを再読み込みしてください。</p>
        <button type="button" onClick={() => window.location.reload()}>操作画面を再読み込み</button>
        <details><summary>エラー詳細</summary><pre>{this.state.error}</pre></details>
      </main>
    );
  }
}
