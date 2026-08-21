export interface Brand {
  code: string;
  name: string;
}

export interface DriveItem {
  id: string;
  name: string;
  type: "folder" | "file";
  size: number | null;
  extension: string | null;
  modified_time: string | null;
  modified_by: string | null;
  created_time: string | null;
  created_by: string | null;
  created_by_email?: string | null;
  members_count?: number | null;
}

export interface TeamFolder {
  id: string;
  name: string;
  members_count?: number | null;
}

export interface Crumb {
  id: string;
  name: string;
}

export type SortKey = "name" | "modified_time" | "size";
export type SortOrder = "asc" | "desc";
