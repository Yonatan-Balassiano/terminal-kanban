import type { PropsWithChildren } from 'react';
import { Box, Text } from 'ink';

export interface ModalOverlayProps extends PropsWithChildren {
  width: number;
  height: number;
}

export function ModalOverlay({
  width,
  height,
  children,
}: ModalOverlayProps): JSX.Element {
  const overlayWidth = Math.max(1, width);
  const overlayHeight = Math.max(1, height);
  const backdropLine = ' '.repeat(overlayWidth);

  return (
    <Box
      position="absolute"
      width={overlayWidth}
      height={overlayHeight}
      flexDirection="column"
      overflow="hidden"
    >
      {Array.from({ length: overlayHeight }, (_, idx) => (
        <Text key={`backdrop:${idx}`} backgroundColor="#111827">
          {backdropLine}
        </Text>
      ))}
      <Box
        position="absolute"
        width={overlayWidth}
        height={overlayHeight}
        justifyContent="center"
        alignItems="center"
        paddingX={2}
        paddingY={1}
        overflow="hidden"
      >
        {children}
      </Box>
    </Box>
  );
}
