// SSHButton.tsx
import React, { useState, useCallback } from 'react';
import { 
  Button, 
  Dialog, 
  DialogTitle, 
  DialogContent, 
  IconButton, 
  Box, 
  Typography, 
  Chip,
  Tooltip,
  useTheme,
  useMediaQuery,
  Alert,
  Snackbar
} from '@mui/material';
import { 
  Terminal as TerminalIcon,
  Close as CloseIcon,
  Circle as CircleIcon,
  Refresh as RefreshIcon
} from '@mui/icons-material';
import SSHTerminal from './Terminal';

interface SSHButtonProps {
  vmId: number;
  vmName: string;
  isRunning: boolean;
  disabled?: boolean;
  variant?: 'button' | 'icon';
  size?: 'small' | 'medium';
}

interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'reconnecting';
  message?: string;
  lastConnected?: Date;
  attemptCount?: number;
}

export const SSHButton: React.FC<SSHButtonProps> = ({ 
  vmId, 
  vmName, 
  isRunning, 
  disabled = false,
  variant = 'button',
  size = 'small'
}) => {
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>({
    status: 'disconnected'
  });
  const [showNotification, setShowNotification] = useState(false);
  const [notificationMessage, setNotificationMessage] = useState('');
  
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  const handleOpenTerminal = useCallback(() => {
    if (isRunning && !disabled) {
      setTerminalOpen(true);
      setConnectionState({ status: 'connecting' });
    }
  }, [isRunning, disabled]);

  const handleCloseTerminal = useCallback(() => {
    setTerminalOpen(false);
    setConnectionState({ status: 'disconnected' });
  }, []);

  const handleConnectionStateChange = useCallback((state: ConnectionState) => {
    setConnectionState(state);
    
    // Show notifications for important state changes
    if (state.status === 'connected') {
      setNotificationMessage(`Connected to ${vmName}`);
      setShowNotification(true);
    } else if (state.status === 'error' && state.message) {
      setNotificationMessage(state.message);
      setShowNotification(true);
    }
  }, [vmName]);

  const getButtonProps = () => {
    if (disabled) {
      return {
        color: '#9e9e9e',
        tooltip: 'SSH not available',
        disabled: true
      };
    }
    
    if (!isRunning) {
      return {
        color: '#ff9800',
        tooltip: 'VM is not running - click to start SSH when running',
        disabled: true
      };
    }
    
    return {
      color: connectionState.status === 'connected' ? '#4caf50' : '#2196f3',
      tooltip: connectionState.status === 'connected' 
        ? `Connected to ${vmName}` 
        : `Connect to ${vmName} via SSH`,
      disabled: false
    };
  };

  const buttonProps = getButtonProps();

  // Icon variant for compact table display
  if (variant === 'icon') {
    return (
      <>
        <Tooltip title={buttonProps.tooltip}>
          <span>
            <IconButton
              onClick={handleOpenTerminal}
              disabled={buttonProps.disabled}
              size={size}
              sx={{
                color: buttonProps.color,
                border: `1px solid ${buttonProps.color}`,
                '&:hover': {
                  backgroundColor: `${buttonProps.color}10`,
                },
                '&:disabled': {
                  borderColor: '#e0e0e0',
                  color: '#9e9e9e'
                }
              }}
            >
              <TerminalIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        {renderModal()}
      </>
    );
  }

  // Button variant
  return (
    <>
      <Tooltip title={buttonProps.tooltip}>
        <span>
          <Button
            startIcon={<TerminalIcon />}
            onClick={handleOpenTerminal}
            disabled={buttonProps.disabled}
            variant="outlined"
            size={size}
            sx={{
              borderColor: buttonProps.color,
              color: buttonProps.color,
              backgroundColor: 'white',
              minWidth: 'auto',
              '&:hover': {
                backgroundColor: `${buttonProps.color}10`,
                borderColor: buttonProps.color,
              },
              '&:disabled': {
                borderColor: '#e0e0e0',
                color: '#9e9e9e'
              }
            }}
          >
            SSH
          </Button>
        </span>
      </Tooltip>
      {renderModal()}
    </>
  );

  function renderModal() {
    return (
      <>
        <Dialog 
          open={terminalOpen} 
          onClose={handleCloseTerminal}
          maxWidth="lg"
          fullWidth
          fullScreen={isMobile}
          PaperProps={{
            sx: {
              borderRadius: isMobile ? 0 : 2,
              backgroundColor: '#202124',
              minHeight: isMobile ? '100vh' : '600px',
              maxHeight: isMobile ? '100vh' : '80vh'
            }
          }}
        >
          <DialogTitle sx={{ 
            color: 'white', 
            backgroundColor: '#202124',
            borderBottom: '1px solid #5f6368',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            p: 2
          }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <TerminalIcon sx={{ color: '#8ab4f8' }} />
              <Typography variant="h6" component="span">
                SSH Terminal
              </Typography>
              <Chip 
                label={vmName} 
                size="small" 
                variant="outlined"
                sx={{ 
                  color: '#8ab4f8',
                  borderColor: '#5f6368',
                  fontSize: '0.75rem'
                }}
              />
              <ConnectionStatusChip state={connectionState} />
            </Box>
            <IconButton
              onClick={handleCloseTerminal}
              size="small"
              sx={{ color: 'white' }}
              aria-label="Close terminal"
            >
              <CloseIcon />
            </IconButton>
          </DialogTitle>
          
          <DialogContent sx={{ 
            backgroundColor: '#202124', 
            p: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}>
            {terminalOpen && (
              <SSHTerminal 
                vmId={vmId}
                vmName={vmName}
                apiBaseUrl={process.env.REACT_APP_API_URL || 'http://localhost:8000/api/v1'}
                onConnectionStateChange={handleConnectionStateChange}
                isOpen={terminalOpen}
              />
            )}
          </DialogContent>
        </Dialog>

        <Snackbar
          open={showNotification}
          autoHideDuration={3000}
          onClose={() => setShowNotification(false)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        >
          <Alert 
            onClose={() => setShowNotification(false)} 
            severity={connectionState.status === 'connected' ? 'success' : 'error'}
            sx={{ width: '100%' }}
          >
            {notificationMessage}
          </Alert>
        </Snackbar>
      </>
    );
  }
};

// Connection Status Chip Component
const ConnectionStatusChip: React.FC<{ state: ConnectionState }> = ({ state }) => {
  const getStatusConfig = () => {
    switch (state.status) {
      case 'connected':
        return { 
          color: '#4caf50', 
          label: 'Connected', 
          icon: <CircleIcon sx={{ fontSize: 8 }} />
        };
      case 'connecting':
        return { 
          color: '#ff9800', 
          label: 'Connecting...', 
          icon: <CircleIcon sx={{ fontSize: 8, animation: 'pulse 1.5s infinite' }} />
        };
      case 'reconnecting':
        return { 
          color: '#ff9800', 
          label: `Reconnecting... (${state.attemptCount || 0}/5)`, 
          icon: <CircleIcon sx={{ fontSize: 8, animation: 'pulse 1.5s infinite' }} />
        };
      case 'error':
        return { 
          color: '#f44336', 
          label: 'Error', 
          icon: <CircleIcon sx={{ fontSize: 8 }} />
        };
      default:
        return { 
          color: '#9e9e9e', 
          label: 'Disconnected', 
          icon: <CircleIcon sx={{ fontSize: 8 }} />
        };
    }
  };

  const config = getStatusConfig();

  return (
    <Tooltip title={state.message || config.label}>
      <Chip
        size="small"
        icon={config.icon}
        label={config.label}
        variant="outlined"
        sx={{ 
          fontSize: '0.7rem',
          height: 20,
          borderColor: config.color,
          color: config.color,
          '& .MuiChip-icon': {
            color: config.color,
            marginLeft: '4px'
          }
        }}
      />
    </Tooltip>
  );
};

export default SSHButton;