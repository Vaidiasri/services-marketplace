import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { App } from '@/App';
import { AuthProvider } from '@/lib/auth';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 403 or 422 will never succeed on retry - retrying them just delays the error
      // the user needs to see. Individual queries opt back in where a retry helps.
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
