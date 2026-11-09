import { SignupForm } from "@/components/signup-form";
import BrandLogo from "@/components/brand-logo";
import { useNavigate } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { AuthService } from "@/services";

export default function SignupPage() {
  const navigate = useNavigate();
  const { updateAuth } = useAuth();

  const handleSubmit = async (credentials: {
    username: string;
    email: string;
    password: string;
  }) => {
    try {
      await AuthService.signup(credentials);
      updateAuth(); // Update auth state immediately
      navigate("/");
    } catch (error) {
      console.error("an error occurred during signup", error);
    }
  };

  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex justify-center gap-2 md:justify-start">
          <a href="/" aria-label="Cinetra home" className="flex items-center gap-2 font-medium">
            <BrandLogo size={32} />
          </a>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-xs">
            <SignupForm handleSubmit={handleSubmit} />
          </div>
        </div>
      </div>
      <div className="relative hidden bg-muted lg:block">
        <img
          src="/images/login-placeholder.png"
          alt="Image"
          className="absolute inset-0 h-full w-full object-cover dark:brightness-[0.2] dark:grayscale"
        />
      </div>
    </div>
  );
}
