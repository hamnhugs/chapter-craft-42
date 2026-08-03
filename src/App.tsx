import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppProvider } from "@/context/AppContext";
import { ChatProvider } from "@/context/ChatContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { useAuth } from "@/hooks/useAuth";
import ErrorBoundary from "@/components/ErrorBoundary";
import Index from "./pages/Index";
import Auth from "./pages/Auth";
// Non-critical routes are code-split so the initial bundle only carries Index/Auth
const MemoryGuide = lazy(() => import("./pages/MemoryGuide"));
const WikiControlsGuide = lazy(() => import("./pages/WikiControlsGuide"));
const Admin = lazy(() => import("./pages/Admin"));
const PaymentSuccess = lazy(() => import("./pages/PaymentSuccess"));
const ModelExplorer = lazy(() => import("./pages/ModelExplorer"));
const NotFound = lazy(() => import("./pages/NotFound"));

const queryClient = new QueryClient();

const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen text-muted-foreground">Loading…</div>;
  if (!user) return <Navigate to="/auth" replace />;
  return <>{children}</>;
};

const AuthRoute: React.FC = () => {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen text-muted-foreground">Loading…</div>;
  if (user) return <Navigate to="/" replace />;
  return <Auth />;
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <ErrorBoundary>
        <HashRouter>
          <AppProvider>
            <ChatProvider>
              {/* Fallback mirrors the ProtectedRoute loading state so chunk loads look identical */}
              <Suspense fallback={<div className="flex items-center justify-center h-screen text-muted-foreground">Loading…</div>}>
              <Routes>
                <Route path="/auth" element={<AuthRoute />} />
                {/* /admin has its own self-contained login gate — not wrapped in ProtectedRoute */}
                <Route path="/admin" element={<Admin />} />
                <Route
                  path="/memory-guide"
                  element={
                    <ProtectedRoute>
                      <MemoryGuide />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/wiki-controls-guide"
                  element={
                    <ProtectedRoute>
                      <WikiControlsGuide />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/models"
                  element={
                    <ProtectedRoute>
                      <ModelExplorer />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/payment-success"
                  element={
                    <ProtectedRoute>
                      <PaymentSuccess />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/"
                  element={
                    <ProtectedRoute>
                      <Index />
                    </ProtectedRoute>
                  }
                />
                <Route path="*" element={<NotFound />} />
              </Routes>
              </Suspense>
            </ChatProvider>
          </AppProvider>
        </HashRouter>
        </ErrorBoundary>
      </TooltipProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
