import { useEffect, useState } from "react";
import { UserService } from "@/services";
import { UserType } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";

interface AccountModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function AccountModal({ open, onOpenChange }: AccountModalProps) {
  const [user, setUser] = useState<UserType | null>(null);
  const [formData, setFormData] = useState({
    username: "",
    email: "",
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (open) {
      fetchUserData();
    }
  }, [open]);

  const fetchUserData = async () => {
    try {
      setIsLoading(true);
      const userData = await UserService.getCurrentUser();
      setUser(userData);
      setFormData({
        username: userData.username,
        email: userData.email,
      });
      setHasChanges(false);
    } catch (error) {
      console.error("Error fetching user data:", error);
      toast.error("Failed to load user data");
    } finally {
      setIsLoading(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));

    // Check if there are changes
    if (user) {
      const hasChanged =
        value !== user[name as keyof Pick<UserType, "username" | "email">] ||
        (name === "username" && value !== user.username) ||
        (name === "email" && value !== user.email);
      
      setHasChanges(hasChanged || formData.username !== user.username || formData.email !== user.email);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!hasChanges) return;

    try {
      setIsSaving(true);
      const updatedUser = await UserService.updateUser(formData);
      setUser(updatedUser);
      setFormData({
        username: updatedUser.username,
        email: updatedUser.email,
      });
      setHasChanges(false);
      toast.success("Account updated successfully");
    } catch (error) {
      console.error("Error updating user data:", error);
      toast.error("Failed to update account");
    } finally {
      setIsSaving(false);
    }
  };

  const exportData = async () => {
    setIsExporting(true);
    try {
      const blob = await UserService.exportData();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `cinetra-export-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch { toast.error("Could not export your data"); }
    finally { setIsExporting(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="account-settings-dialog sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Account Settings</DialogTitle>
          <DialogDescription>
            Manage your account information and preferences
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-10 w-full" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-10 w-full" />
            </div>
            <Skeleton className="h-10 w-24" />
          </div>
        ) : (
          <>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  name="username"
                  type="text"
                  value={formData.username}
                  onChange={handleInputChange}
                  placeholder="Enter your username"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  value={formData.email}
                  onChange={handleInputChange}
                  placeholder="Enter your email"
                  required
                />
              </div>

              <Button
                type="submit"
                disabled={!hasChanges || isSaving}
                className="w-full"
              >
                {isSaving ? "Updating..." : "Update Account"}
              </Button>
            </form>
            <Button type="button" variant="outline" className="w-full" disabled={isExporting} onClick={exportData}>
              {isExporting ? "Preparing export..." : "Export my data"}
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
