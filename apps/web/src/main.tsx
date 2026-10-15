import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from './lib/api';
import { createAppRouter } from './router';
import './styles/app.css';

/** Session-level problems: the router's guards decide where to send the person next. */
const SESSION_PROBLEMS = new Set([
  'unauthenticated',
  'email_not_verified',
  'mfa_required',
  'mfa_setup_required',
]);

function onError(error: unknown) {
  if (error instanceof ApiError && error.code && SESSION_PROBLEMS.has(error.code)) {
    void queryClient.invalidateQueries({ queryKey: ['me'] }).then(() => router.invalidate());
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      retry: (failureCount, error) =>
        !(error instanceof ApiError && error.status < 500) && failureCount < 2,
      refetchOnWindowFocus: false,
    },
  },
});
const router = createAppRouter(queryClient);

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
