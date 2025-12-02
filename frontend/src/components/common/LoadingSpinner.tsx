import { Loader2 } from 'lucide-react';

export function LoadingSpinner({ fullScreen = false }: { fullScreen?: boolean }) {
  const spinner = (
    <div className="flex items-center justify-center">
      <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
    </div>
  );
  if (fullScreen) {
    return <div className="min-h-[300px] flex items-center justify-center">{spinner}</div>;
  }
  return spinner;
}

