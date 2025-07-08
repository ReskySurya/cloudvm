import React, { useEffect, useRef, useCallback, Component, ErrorInfo } from 'react';
import { Terminal } from 'xterm';
import { WebglAddon } from 'xterm-addon-webgl';
import { FitAddon } from 'xterm-addon-fit';
import { Box, Button, Typography, Alert } from '@mui/material';
import { Refresh as RefreshIcon, Warning as WarningIcon } from '@mui/icons-material';
import 'xterm/css/xterm.css';

const TOKEN_KEY = 'auth_token';
const RECONNECT_INTERVAL = 3000;
const MAX_RECONNECT_ATTEMPTS = 5;
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'reconnecting';
  message?: string;
  lastConnected?: Date;
  attemptCount?: number;
}

class TerminalErrorBoundary extends Component<
  { 
    children: React.ReactNode; 
    onError?: (error: Error) => void;
    onRetry?: () => void;
  },
  { hasError: boolean; error?: Error }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Terminal Error:', error, errorInfo);
    this.props.onError?.(error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <Box sx={{ 
          p: 3, 
          textAlign: 'center',
          backgroundColor: '#1e1e1e',
          color: '#ffffff',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center'
        }}>
          <WarningIcon sx={{ fontSize: 48, color: '#ff6b6b', mb: 2 }} />
          <Typography variant="h6" gutterBottom>
            Terminal Error
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3, color: '#9e9e9e' }}>
            {this.state.error?.message || 'An unexpected error occurred'}
          </Typography>
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button 
              variant="outlined" 
              onClick={this.props.onRetry}
              startIcon={<RefreshIcon />}
              sx={{ color: '#8ab4f8', borderColor: '#8ab4f8' }}
            >
              Retry Connection
            </Button>
            <Button 
              variant="outlined" 
              onClick={() => window.location.reload()}
              sx={{ color: '#8ab4f8', borderColor: '#8ab4f8' }}
            >
              Refresh Page
            </Button>
          </Box>
        </Box>
      );
    }
    return this.props.children;
  }
}

interface SSHTerminalProps {
  vmId: number;
  vmName: string;
  apiBaseUrl: string;
  onConnectionStateChange?: (state: ConnectionState) => void;
  isOpen: boolean;
}

const TerminalComponent: React.FC<SSHTerminalProps> = ({ 
  vmId, 
  vmName,
  apiBaseUrl, 
  onConnectionStateChange,
  isOpen 
}) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const websocketRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isConnectingRef = useRef(false);

  const updateConnectionState = useCallback((state: ConnectionState) => {
    onConnectionStateChange?.(state);
  }, [onConnectionStateChange]);

  const cleanup = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (websocketRef.current) {
      websocketRef.current.close(1000, 'Component cleanup');
      websocketRef.current = null;
    }
    isConnectingRef.current = false;
  }, []);

  const connectWebSocket = useCallback(() => {
    if (!isOpen || isConnectingRef.current) return;

    cleanup();
    isConnectingRef.current = true;

    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      updateConnectionState({
        status: 'error',
        message: 'Authentication required. Please log in again.'
      });
      isConnectingRef.current = false;
      return;
    }

    const isReconnecting = reconnectAttemptsRef.current > 0;
    updateConnectionState({ 
      status: isReconnecting ? 'reconnecting' : 'connecting',
      attemptCount: reconnectAttemptsRef.current
    });

    const baseUrl = apiBaseUrl.replace(/\/$/, '').replace(/\/api\/v1$/, '');
    const wsBaseUrl = baseUrl.replace(/^http/, 'ws');
    const wsUrl = `${wsBaseUrl}/api/v1/ssh/ws/ssh/${vmId}?token=${encodeURIComponent(token)}`;
    
    try {
      const ws = new WebSocket(wsUrl);
      websocketRef.current = ws;

      const connectionTimeout = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.close();
          updateConnectionState({
            status: 'error',
            message: 'Connection timeout'
          });
          isConnectingRef.current = false;
        }
      }, 10000); // 10 second timeout

      ws.onopen = () => {
        clearTimeout(connectionTimeout);
        isConnectingRef.current = false;
        reconnectAttemptsRef.current = 0;
        
        updateConnectionState({ 
          status: 'connected',
          lastConnected: new Date()
        });

        const term = xtermRef.current;
        if (term) {
          const dimensions = { cols: term.cols, rows: term.rows };
          ws.send(JSON.stringify({ type: 'resize', ...dimensions }));

          term.onData((data: string) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'input', data }));
            }
          });

          term.onResize((size: { cols: number; rows: number }) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'resize',
                cols: size.cols,
                rows: size.rows
              }));
            }
          });

          // Welcome message
          term.clear();
          term.writeln(`\r\n\x1b[32m✓ Connected to ${vmName}\x1b[0m`);
          term.writeln(`\x1b[90mConnection established at ${new Date().toLocaleTimeString()}\x1b[0m\r\n`);
        }

        // Start heartbeat
        heartbeatIntervalRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, HEARTBEAT_INTERVAL);
      };

      ws.onmessage = (event) => {
        const term = xtermRef.current;
        if (!term) return;

        try {
          // Try to parse as JSON first (for control messages)
          const message = JSON.parse(event.data);
          if (message.type === 'pong') {
            // Handle heartbeat response
            return;
          }
        } catch {
          // Not JSON, treat as terminal output
          if (typeof event.data === 'string') {
            term.write(event.data);
          } else if (event.data instanceof Blob) {
            const reader = new FileReader();
            reader.onload = () => {
              const text = reader.result?.toString();
              if (text) term.write(text);
            };
            reader.readAsText(event.data);
          }
        }
      };

      ws.onclose = (event) => {
        clearTimeout(connectionTimeout);
        isConnectingRef.current = false;
        
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
          heartbeatIntervalRef.current = null;
        }

        const term = xtermRef.current;
        if (term && event.code !== 1000) {
          term.writeln(`\r\n\x1b[31m✗ Connection lost (${event.code})\x1b[0m`);
          if (event.reason) {
            term.writeln(`\x1b[90mReason: ${event.reason}\x1b[0m`);
          }
        }

        // Auto-reconnect logic
        if (isOpen && event.code !== 1000 && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttemptsRef.current++;
          updateConnectionState({ 
            status: 'reconnecting',
            message: `Reconnecting... (${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS})`,
            attemptCount: reconnectAttemptsRef.current
          });
          
          reconnectTimeoutRef.current = setTimeout(() => {
            connectWebSocket();
          }, RECONNECT_INTERVAL);
        } else {
          const message = event.code === 1000 
            ? 'Connection closed' 
            : reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS
              ? 'Failed to reconnect after multiple attempts'
              : 'Connection failed';
              
          updateConnectionState({ 
            status: 'error',
            message
          });
        }
      };

      ws.onerror = (error) => {
        clearTimeout(connectionTimeout);
        isConnectingRef.current = false;
        console.error('WebSocket error:', error);
        updateConnectionState({ 
          status: 'error',
          message: 'Connection error occurred'
        });
      };

    } catch (error) {
      isConnectingRef.current = false;
      console.error('Failed to create WebSocket:', error);
      updateConnectionState({
        status: 'error',
        message: 'Failed to establish connection'
      });
    }
  }, [vmId, vmName, apiBaseUrl, updateConnectionState, isOpen, cleanup]);

  const handleResize = useCallback(() => {
    if (fitAddonRef.current && xtermRef.current) {
      try {
        fitAddonRef.current.fit();
        const term = xtermRef.current;
        if (websocketRef.current?.readyState === WebSocket.OPEN) {
          const dimensions = { cols: term.cols, rows: term.rows };
          websocketRef.current.send(JSON.stringify({ type: 'resize', ...dimensions }));
        }
      } catch (err) {
        console.error('Error resizing terminal:', err);
      }
    }
  }, []);

  const handleRetry = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    connectWebSocket();
  }, [connectWebSocket]);

  useEffect(() => {
    if (!terminalRef.current || !isOpen) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#ffffff',
        cursor: '#ffffff',
        selectionBackground: 'rgba(255, 255, 255, 0.3)',
        black: '#000000',
        red: '#e06c75',
        green: '#98c379',
        yellow: '#d19a66',
        blue: '#61afef',
        magenta: '#c678dd',
        cyan: '#56b6c2',
        white: '#ffffff',
        brightBlack: '#5c6370',
        brightRed: '#e06c75',
        brightGreen: '#98c379',
        brightYellow: '#d19a66',
        brightBlue: '#61afef',
        brightMagenta: '#c678dd',
        brightCyan: '#56b6c2',
        brightWhite: '#ffffff'
      },
      allowTransparency: false,
      scrollback: 10000,
      rightClickSelectsWord: true,
      macOptionIsMeta: true
    });

    term.open(terminalRef.current);
    xtermRef.current = term;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);

    // Try to load WebGL addon for better performance
    try {
      const webglAddon = new WebglAddon();
      webglAddonRef.current = webglAddon;
      term.loadAddon(webglAddon);
    } catch (e) {
      console.warn('WebGL addon could not be loaded:', e);
    }

    // Initial fit and connection
    setTimeout(() => {
      fitAddon.fit();
      connectWebSocket();
    }, 100);

    // Handle window resize
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      cleanup();
      if (webglAddonRef.current) {
        try {
          webglAddonRef.current.dispose();
        } catch (e) {
          console.warn('Error disposing WebGL addon:', e);
        }
      }
      if (term) {
        term.dispose();
      }
    };
  }, [isOpen, connectWebSocket, handleResize, cleanup]);

  return (
    <TerminalErrorBoundary onRetry={handleRetry}>
      <Box
        ref={terminalRef}
        sx={{
          height: '100%',
          width: '100%',
          backgroundColor: '#1e1e1e',
          overflow: 'hidden',
          '& .xterm': {
            height: '100% !important',
            padding: '16px'
          },
          '& .xterm-viewport': {
            backgroundColor: '#1e1e1e !important'
          }
        }}
      />
    </TerminalErrorBoundary>
  );
};

export const SSHTerminal: React.FC<SSHTerminalProps> = (props) => (
  <TerminalComponent {...props} />
);

export default SSHTerminal;