import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
}

function readTerminalSize(stdout: NodeJS.WriteStream): TerminalSize {
  return {
    columns: stdout.columns ?? process.stdout.columns ?? 80,
    rows: stdout.rows ?? process.stdout.rows ?? 24,
  };
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => readTerminalSize(stdout));

  useEffect(() => {
    const update = () => {
      setSize(readTerminalSize(stdout));
    };

    update();
    stdout.on('resize', update);

    return () => {
      stdout.off('resize', update);
    };
  }, [stdout]);

  return size;
}
