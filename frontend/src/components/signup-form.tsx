import { T } from "@/i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";

interface SignupFormProps extends React.ComponentProps<"form"> {
  handleSubmit?: (credentials: { username: string; email: string; password: string }) => void;
}

export function SignupForm({ className, handleSubmit: onSubmit, ...props }: SignupFormProps) {
  const [formData, setFormData] = useState({
    username: "",
    email: "",
    password: "",
    passwordConfirmation: "",
  });

  const [error, setError] = useState<string>("");

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { id, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [id]: value,
    }));
    // Clear error when user starts typing
    if (error) setError("");
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    // Validate password confirmation
    if (formData.password !== formData.passwordConfirmation) {
      setError("Passwords do not match");
      return;
    }

    if (onSubmit) {
      // Send only username, email, and password (not passwordConfirmation)
      onSubmit({
        username: formData.username,
        email: formData.email,
        password: formData.password,
      });
    } else {
      console.log("Form submitted:", {
        username: formData.username,
        email: formData.email,
        password: formData.password,
      });
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className={cn("flex flex-col gap-6", className)}
      {...props}
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-bold"><T>Create an account</T></h1>
        <p className="text-muted-foreground text-sm text-balance">
          <T>Enter your information below to create your account</T>
        </p>
      </div>
      <div className="grid gap-6">
        <div className="grid gap-3">
          <Label htmlFor="username"><T>Username</T></Label>
          <Input
            id="username"
            autoComplete="username"
            type="text"
            placeholder="e.g., John"
            value={formData.username}
            onChange={handleChange}
            required
          />
        </div>
        <div className="grid gap-3">
          <Label htmlFor="email"><T>Email</T></Label>
          <Input
            id="email"
            autoComplete="email"
            type="email"
            placeholder="m@example.com"
            value={formData.email}
            onChange={handleChange}
            required
          />
        </div>
        <div className="grid gap-3">
          <Label htmlFor="password"><T>Password</T></Label>
          <Input
            id="password"
            autoComplete="new-password"
            type="password"
            value={formData.password}
            onChange={handleChange}
            required
          />
        </div>
        <div className="grid gap-3">
          <Label htmlFor="passwordConfirmation"><T>Confirm Password</T></Label>
          <Input
            id="passwordConfirmation"
            autoComplete="new-password"
            type="password"
            value={formData.passwordConfirmation}
            onChange={handleChange}
            required
          />
        </div>
        {error && (
          <div className="text-sm text-destructive">
            {error}
          </div>
        )}
        <Button type="submit" className="w-full">
          <T>Sign up</T>
        </Button>
      </div>
      <div className="text-center text-sm">
        <T>Already have an account?</T>{" "}
        <a href="/login" className="underline underline-offset-4">
          <T>Login</T>
        </a>
      </div>
    </form>
  );
}
