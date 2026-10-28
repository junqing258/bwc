import { create } from "zustand";
import type { Project } from "../../../server/types";

type LocalProject = Project & { projectId: string };
type ProjectListUpdate =
  | LocalProject[]
  | ((projects: LocalProject[]) => LocalProject[]);

interface ProjectState {
  projects: LocalProject[];
  activeProjectId: string;
  setProjects: (update: ProjectListUpdate) => void;
  setActiveProjectId: (projectId: string) => void;
}

// Project data remains on the server; only the current list and active ID live here.
export const useProjectStore = create<ProjectState>()((set) => ({
  projects: [],
  activeProjectId: "",
  setProjects: (update) =>
    set((state) => ({
      projects: typeof update === "function" ? update(state.projects) : update,
    })),
  setActiveProjectId: (activeProjectId) => set({ activeProjectId }),
}));
