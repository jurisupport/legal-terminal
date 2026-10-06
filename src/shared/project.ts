export interface ProjectCaseLink {
  key: string
  name: string
  jsId?: string
  caseNumber?: string
  court?: string
  drafts?: string
  records?: string
  profileId?: string
  remotePath?: string
}

export interface ProjectFolderLink {
  name: string
  path: string
}

export interface Project {
  id: string
  name: string
  goal: string
  nextAction: string
  notes: string
  status: 'active' | 'completed'
  cases: ProjectCaseLink[]
  folders: ProjectFolderLink[]
  createdAt: string
  updatedAt: string
}

export type ProjectInput = Pick<Project, 'name' | 'goal' | 'nextAction' | 'notes' | 'status' | 'cases'> & {
  folders?: ProjectFolderLink[]
  id?: string
  expectedUpdatedAt?: string
}
