import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll } from 'vitest';

beforeAll(() => {
  const getComputedStyle = window.getComputedStyle.bind(window);
  Object.defineProperty(window, 'getComputedStyle', {
    writable: true,
    value: (element: Element) => getComputedStyle(element),
  });
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => {
      const minWidth = query.match(/min-width:\s*(\d+)px/);
      const maxWidth = query.match(/max-width:\s*(\d+)px/);
      const matches =
        (minWidth === null || window.innerWidth >= Number(minWidth[1])) &&
        (maxWidth === null || window.innerWidth <= Number(maxWidth[1]));
      return {
        matches,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      };
    },
  });
  Object.defineProperty(window, 'ResizeObserver', {
    writable: true,
    value: class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  window.innerWidth = 1024;
});
