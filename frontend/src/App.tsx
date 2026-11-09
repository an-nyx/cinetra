import { FC } from "react";
import { useAuth } from "./hooks/use-auth.tsx";
import {
  createBrowserRouter,
  Navigate,
  useRouteError,
  
} from "react-router";
import { RouterProvider } from "react-router/dom";


import ShowsPage from "./pages/shows-page.tsx";
import MoviesPage from "./pages/Movies-page.tsx";
import LoginPage from "./pages/login-page.tsx";
import SignupPage from "./pages/signup-page.tsx";
import WelcomePage from "./pages/welcome-page.tsx";
import UpcomingPage from "./pages/upcoming-page.tsx";
import { AuthProvider } from "./context/auth-context.tsx";
import { ThemeProvider } from "./components/theme-provider.tsx";
import HomePage from "./pages/home-page.tsx";
import MatchReviewPage from "./pages/match-review-page.tsx";

const router = createBrowserRouter([
  {
    path: "/",
    errorElement: <RouteRecovery />,
    element: (
      <ProtectedRoute>
        <HomePage />
      </ProtectedRoute>
    ),
    children: [
      {
        index: true,
        element: <WelcomePage />,
      },
      {
        path: "/shows",
        element: <ShowsPage />,
      },
      {
        path: "/upcoming",
        element: <UpcomingPage />,
      },
      {
        path: "/movies",
        element: <MoviesPage />,
      },
      {
        path: "/review-matches",
        element: <MatchReviewPage />,
      },
    ],
  },
  {
    path: "/login",
    element: <LoginPage />,
  },
  {
    path: "/signup",
    element: <SignupPage />,
  },
]);

function RouteRecovery() {
  const error = useRouteError();
  console.error('Cinetra route error', error);
  return <main className="flex min-h-[100dvh] items-center justify-center bg-background px-5 py-10 text-foreground"><section className="w-full max-w-md rounded-2xl border bg-card p-6 text-center shadow-lg"><p className="cinema-eyebrow">Cinetra</p><h1 className="mt-3 text-2xl font-semibold">This page could not be opened</h1><p className="mt-2 text-sm text-muted-foreground">Your library data is still saved. Try again or return to your home page.</p><div className="mt-5 flex justify-center gap-3"><button className="min-h-11 rounded-xl border px-4 text-sm font-medium" onClick={() => window.location.reload()}>Reload</button><a className="inline-flex min-h-11 items-center rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground" href="/">Go to Home</a></div></section></main>;
}

const App: FC = () => {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </ThemeProvider>
  );
};

function ProtectedRoute({ children }: { children: JSX.Element }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) {
    console.log("you're not authenticated!");
    return <Navigate to="/login" replace />;
  }
  return children;
}

export default App;
