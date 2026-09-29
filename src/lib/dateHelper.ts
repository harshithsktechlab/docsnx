/**
 * Centralized date helper for DD/MM/YYYY formats
 */

export function formatDate(dateInput: string | Date | number | null | undefined): string {
  if (!dateInput) return '';
  try {
    const date = new Date(dateInput);
    if (isNaN(date.getTime())) return '';
    
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    
    return `${day}/${month}/${year}`;
  } catch (error) {
    console.error('Error formatting date:', error);
    return '';
  }
}

export function parseDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  try {
    // Expecting dd/mm/yyyy
    const parts = dateStr.split('/');
    if (parts.length !== 3) {
      // Fallback to standard parsing if it's already yyyy-mm-dd
      const fallback = new Date(dateStr);
      return isNaN(fallback.getTime()) ? null : fallback;
    }
    
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const year = parseInt(parts[2], 10);
    
    const date = new Date(year, month, day);
    return isNaN(date.getTime()) ? null : date;
  } catch (error) {
    console.error('Error parsing date:', error);
    return null;
  }
}
