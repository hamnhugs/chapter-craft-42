export interface Chapter {
  id: string;
  name: string;
  startPage: number;
  endPage: number;
  textContent: string;
}

export interface BookDocument {
  id: string;
  title: string;
  fileName: string;
  fileData: string; // base64 data URL
  pageCount: number;
  chapters: Chapter[];
  addedAt: number;
  coverImageUrl?: string;
}
