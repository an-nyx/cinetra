import { FC } from "react";
import { useAuth } from "./hooks/use-auth.tsx";
import {
  createBrowserRouter,
  Navigate,
  
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
