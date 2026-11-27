import * as React from 'react';
import { BaseInput } from './input-base';
import { DateInput } from './date-field';

/**
 * `type="date"` is drawn by DateField, so every form types and shows
 * DD/MM/YYYY whatever the device's locale. Its `value` and `onChange` behave
 * like the native control's: `YYYY-MM-DD` or ''.
 */
const Input = React.forwardRef(({ type, ...props }, ref) => (
  type === 'date'
    ? <DateInput {...props} ref={ref} />
    : <BaseInput {...props} type={type} ref={ref} />
));
Input.displayName = 'Input';

export { Input };
