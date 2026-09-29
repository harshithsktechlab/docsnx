import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PWABanner } from './PWABanner';

describe('PWABanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    
    // Reset matchMedia
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(query => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(), // Deprecated
        removeListener: vi.fn(), // Deprecated
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it('does not show banner initially', () => {
    const { container } = render(<PWABanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows banner when beforeinstallprompt event is fired', async () => {
    render(<PWABanner />);
    
    const event = new Event('beforeinstallprompt');
    Object.defineProperty(event, 'prompt', { value: vi.fn() });
    
    await act(async () => {
      window.dispatchEvent(event);
    });
    
    expect(screen.getByText('Install DocsNX App')).toBeInTheDocument();
  });

  it('does not show banner if already dismissed', async () => {
    localStorage.setItem('pwa-banner-dismissed', 'true');
    render(<PWABanner />);
    
    const event = new Event('beforeinstallprompt');
    await act(async () => {
      window.dispatchEvent(event);
    });
    
    expect(screen.queryByText('Install DocsNX App')).not.toBeInTheDocument();
  });

  it('dismisses banner when close button is clicked', async () => {
    render(<PWABanner />);
    
    const event = new Event('beforeinstallprompt');
    await act(async () => {
      window.dispatchEvent(event);
    });
    
    expect(screen.getByText('Install DocsNX App')).toBeInTheDocument();
    
    const buttons = screen.getAllByRole('button');
    const closeButton = buttons[0];
    
    await act(async () => {
      fireEvent.click(closeButton);
    });
    
    expect(screen.queryByText('Install DocsNX App')).not.toBeInTheDocument();
    expect(localStorage.getItem('pwa-banner-dismissed')).toBe('true');
  });

  it('prompts installation when install button is clicked', async () => {
    render(<PWABanner />);
    
    const promptMock = vi.fn();
    const event = new Event('beforeinstallprompt') as any;
    event.prompt = promptMock;
    event.userChoice = Promise.resolve({ outcome: 'accepted' });
    
    await act(async () => {
      window.dispatchEvent(event);
    });
    
    const installButton = screen.getByText('Install App');
    await act(async () => {
      fireEvent.click(installButton);
    });
    
    expect(promptMock).toHaveBeenCalled();
    expect(screen.queryByText('Install DocsNX App')).not.toBeInTheDocument();
  });

  it('does not register listener if already installed via matchMedia', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(query => ({
        matches: query === '(display-mode: standalone)',
        media: query,
        onchange: null,
      })),
    });
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
    render(<PWABanner />);
    expect(addEventListenerSpy).not.toHaveBeenCalledWith('beforeinstallprompt', expect.any(Function));
  });

  it('hides banner when appinstalled event is fired', async () => {
    render(<PWABanner />);
    
    // First show the banner
    const event = new Event('beforeinstallprompt');
    await act(async () => {
      window.dispatchEvent(event);
    });
    
    expect(screen.getByText('Install DocsNX App')).toBeInTheDocument();
    
    // Now trigger appinstalled
    const installedEvent = new Event('appinstalled');
    await act(async () => {
      window.dispatchEvent(installedEvent);
    });
    
    expect(screen.queryByText('Install DocsNX App')).not.toBeInTheDocument();
    expect(localStorage.getItem('pwa-installed')).toBe('true');
  });


  it('does nothing if install button clicked when deferredPrompt is null', async () => {
    render(<PWABanner />);
    
    // First show the banner
    const event = new Event('beforeinstallprompt');
    Object.defineProperty(event, 'prompt', { value: vi.fn() });
    await act(async () => {
      window.dispatchEvent(event);
    });
    
    expect(screen.getByText('Install DocsNX App')).toBeInTheDocument();
    
    // Manually trigger installed event which sets deferredPrompt to null
    const installedEvent = new Event('appinstalled');
    await act(async () => {
      window.dispatchEvent(installedEvent);
    });
    
    // The banner is hidden, but let's mock it so the banner stays open while deferredPrompt becomes null.
  });

  const setUserAgent = (ua: string) => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: ua });
  };

  const IPHONE_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

  describe('iOS', () => {
    const realUserAgent = navigator.userAgent;

    afterEach(() => {
      setUserAgent(realUserAgent);
      vi.useRealTimers();
    });

    it('shows Add to Home Screen instructions on iOS Safari after the dwell delay', async () => {
      setUserAgent(IPHONE_UA);
      vi.useFakeTimers();
      render(<PWABanner />);

      // Held back until the visitor has actually stuck around.
      expect(screen.queryByText('Install DocsNX App')).not.toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(8000);
      });

      expect(screen.getByText('Install DocsNX App')).toBeInTheDocument();
      expect(screen.getByText('Add to Home Screen')).toBeInTheDocument();
      // iOS gives no programmatic install, so there must be no install button.
      expect(screen.queryByText('Install App')).not.toBeInTheDocument();
    });

    it('does not show the iOS card in Chrome on iOS, which has no Add to Home Screen', async () => {
      setUserAgent(IPHONE_UA.replace('Safari/604.1', 'CriOS/120.0 Mobile/15E148 Safari/604.1'));
      vi.useFakeTimers();
      render(<PWABanner />);

      await act(async () => {
        vi.advanceTimersByTime(8000);
      });

      expect(screen.queryByText('Install DocsNX App')).not.toBeInTheDocument();
    });

    it('does not show the iOS card once launched standalone', async () => {
      setUserAgent(IPHONE_UA);
      Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
      vi.useFakeTimers();
      const { container } = render(<PWABanner />);

      await act(async () => {
        vi.advanceTimersByTime(8000);
      });

      expect(container).toBeEmptyDOMElement();
      Object.defineProperty(navigator, 'standalone', { configurable: true, value: undefined });
    });
  });

  describe('update prompt', () => {
    afterEach(() => {
      // @ts-expect-error - removing the stub we installed
      delete navigator.serviceWorker;
      sessionStorage.clear();
      vi.useRealTimers();
    });

    /**
     * The container has to be a real event target: `updateApp` now waits for
     * `controllerchange` before reloading, so the tests need to fire it.
     */
    const stubWaitingWorker = ({ waiting = true } = {}) => {
      const postMessage = vi.fn();
      const registration = {
        waiting: waiting ? { postMessage } : null,
        addEventListener: vi.fn(),
      };
      const container = new EventTarget();
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          ready: Promise.resolve(registration),
          controller: {},
          addEventListener: container.addEventListener.bind(container),
          removeEventListener: container.removeEventListener.bind(container),
          dispatchEvent: container.dispatchEvent.bind(container),
        },
      });
      return { postMessage, controllerChange: () => container.dispatchEvent(new Event('controllerchange')) };
    };

    const stubReload = () => {
      const reload = vi.fn();
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, reload },
      });
      return reload;
    };

    it('offers a reload when a service worker update is waiting', async () => {
      stubWaitingWorker();
      render(<PWABanner />);

      await act(async () => {});

      expect(screen.getByText('A new version is ready')).toBeInTheDocument();
    });

    it('reloads only once the new worker has taken over', async () => {
      const { postMessage, controllerChange } = stubWaitingWorker();
      const reload = stubReload();

      render(<PWABanner />);
      await act(async () => {});

      await act(async () => {
        fireEvent.click(screen.getByText('Reload now'));
      });

      expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      // Reloading here would be served by the *old* worker, which is what put
      // the banner back on screen after every "Reload now".
      expect(reload).not.toHaveBeenCalled();
      expect(screen.getByText('Updating…')).toBeInTheDocument();

      await act(async () => {
        controllerChange();
      });

      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('reloads anyway if the worker never takes over', async () => {
      vi.useFakeTimers();
      const { controllerChange } = stubWaitingWorker();
      const reload = stubReload();

      render(<PWABanner />);
      await act(async () => {});

      await act(async () => {
        fireEvent.click(screen.getByText('Reload now'));
      });
      expect(reload).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      expect(reload).toHaveBeenCalledTimes(1);

      // A late `controllerchange` must not reload a second time.
      await act(async () => {
        controllerChange();
      });
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('can be dismissed', async () => {
      stubWaitingWorker();
      render(<PWABanner />);
      await act(async () => {});

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Dismiss'));
      });

      expect(screen.queryByText('A new version is ready')).not.toBeInTheDocument();
      // Session-only: the next build must still be able to prompt.
      expect(localStorage.getItem('pwa-banner-dismissed')).toBeNull();
    });

    it('does not prompt again for an update the user already accepted', async () => {
      sessionStorage.setItem('pwa-update-accepted', 'true');
      stubWaitingWorker();
      const { container } = render(<PWABanner />);

      await act(async () => {});

      expect(container).toBeEmptyDOMElement();
      // Consumed, so a genuinely newer build still gets to prompt.
      expect(sessionStorage.getItem('pwa-update-accepted')).toBeNull();
    });

    it('shows the update prompt to an installed (standalone) app', async () => {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: vi.fn().mockImplementation(query => ({
          matches: query === '(display-mode: standalone)',
          media: query,
          onchange: null,
        })),
      });
      stubWaitingWorker();
      render(<PWABanner />);

      await act(async () => {});

      expect(screen.getByText('A new version is ready')).toBeInTheDocument();
    });

    it('just clears the prompt when nothing is actually waiting', async () => {
      stubWaitingWorker();
      const reload = stubReload();
      render(<PWABanner />);
      await act(async () => {});

      // The worker activated on its own between render and click.
      const registration = await navigator.serviceWorker.ready;
      (registration as any).waiting = null;

      await act(async () => {
        fireEvent.click(screen.getByText('Reload now'));
      });

      expect(reload).not.toHaveBeenCalled();
      expect(screen.queryByText('A new version is ready')).not.toBeInTheDocument();
    });

    it('shows the update prompt even after the install banner was dismissed', async () => {
      localStorage.setItem('pwa-banner-dismissed', 'true');
      stubWaitingWorker();
      render(<PWABanner />);

      await act(async () => {});

      expect(screen.getByText('A new version is ready')).toBeInTheDocument();
    });
  });

  it('handles user dismissing the install prompt', async () => {
    render(<PWABanner />);
    
    const promptMock = vi.fn();
    const event = new Event('beforeinstallprompt') as any;
    event.prompt = promptMock;
    event.userChoice = Promise.resolve({ outcome: 'dismissed' });
    
    await act(async () => {
      window.dispatchEvent(event);
    });
    
    const installButton = screen.getByText('Install App');
    await act(async () => {
      fireEvent.click(installButton);
    });
    
    expect(promptMock).toHaveBeenCalled();
    // Banner should remain visible if outcome is dismissed
    expect(screen.getByText('Install DocsNX App')).toBeInTheDocument();

    // Click again, deferredPrompt is now null
    await act(async () => {
      fireEvent.click(installButton);
    });

    // Should not throw and promptMock not called again
    expect(promptMock).toHaveBeenCalledTimes(1);
  });
});
