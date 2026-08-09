import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/context/AuthContext";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppShell } from "@/components/AppShell";
import { I18nProvider } from "@/i18n";

import Auth from "./pages/Auth";
import Onboarding from "./pages/Onboarding";
import Home from "./pages/Home";
import AnimeDetail from "./pages/AnimeDetail";
import EpisodeDetail from "./pages/EpisodeDetail";
import StudySession from "./pages/StudySession";
import VoiceStudySession from "./pages/VoiceStudySession";
import StudyChunk from "./pages/StudyChunk";
import ChunkQuiz from "./pages/ChunkQuiz";
import WatchEpisode from "./pages/WatchEpisode";

import Stats from "./pages/Stats";
import Settings from "./pages/Settings";
import Recommendations from "./pages/Recommendations";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner theme="dark" />
      <BrowserRouter>
        <AuthProvider>
          <I18nProvider>
          <Routes>
            <Route path="/auth" element={<Auth />} />
            <Route
              path="/onboarding"
              element={
                <RequireUser><Onboarding /></RequireUser>
              }
            />
            <Route
              element={
                <ProtectedRoute>
                  <AppShell />
                </ProtectedRoute>
              }
            >
              <Route path="/" element={<Home />} />
              <Route path="/recommendations" element={<Recommendations />} />
              <Route path="/stats" element={<Stats />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/anime/:animeId" element={<AnimeDetail />} />
              <Route path="/episode/:episodeId" element={<EpisodeDetail />} />
              <Route path="/study/:episodeId" element={<StudySession />} />
              <Route path="/study/:episodeId/voice" element={<VoiceStudySession />} />
              <Route path="/episode/:episodeId/quiz" element={<ChunkQuiz />} />
              <Route path="/episode/:episodeId/watch" element={<WatchEpisode />} />
              <Route path="/study/chunk/:chunkId" element={<StudyChunk />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
          </I18nProvider>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

// onboarding only requires user (not placement_done)
import { useAuth } from "@/context/AuthContext";
import { Navigate } from "react-router-dom";
function RequireUser({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen grid place-items-center text-muted-foreground">Loading…</div>;
  if (!user) return <Navigate to="/auth" replace />;
  return children;
}

export default App;
