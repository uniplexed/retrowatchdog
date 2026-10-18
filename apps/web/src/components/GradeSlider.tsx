import type { ItemGrade } from "@retrowatchdog/shared";

/** slider position 0..5 -> grade, worst to best */
export const GRADE_STEPS: readonly ItemGrade[] = [
  "poor",
  "fair",
  "good",
  "very_good",
  "near_mint",
  "mint",
];

export function gradeLabel(grade: ItemGrade): string {
  return grade.replaceAll("_", " ");
}

/**
 * Range control over the six-grade scale. An unset grade parks the thumb at
 * "good" but labels "—": onChange fires only on a real move, so no grade is
 * invented.
 */
export function GradeSlider({
  grade,
  onChange,
  label = "Grade",
}: {
  grade: ItemGrade | null;
  onChange: (grade: ItemGrade) => void;
  label?: string;
}) {
  const position = grade === null ? 3 : GRADE_STEPS.indexOf(grade);
  return (
    <label className="grade-slider source-note">
      {label}{" "}
      <input
        type="range"
        min={0}
        max={5}
        step={1}
        value={position}
        aria-label={label}
        onChange={(e) => onChange(GRADE_STEPS[Number(e.target.value)])}
      />{" "}
      <span className="meta">{grade === null ? "—" : gradeLabel(grade)}</span>
    </label>
  );
}
