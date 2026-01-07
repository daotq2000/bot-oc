import { Component } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  handleReset = () => {
    this.setState({ hasError: false });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[300px] flex flex-col items-center justify-center text-center space-y-4">
          <AlertCircle className="w-10 h-10 text-red-500" />
          <div>
            <h2 className="text-xl font-semibold">Something went wrong</h2>
            <p className="text-gray-500">Please refresh the page or try again later.</p>
          </div>
          <Button onClick={this.handleReset}>Refresh</Button>
        </div>
      );
    }

    return this.props.children;
  }
}

