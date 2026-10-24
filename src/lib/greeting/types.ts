export type ProductKey = 'crm' | 'people' | 'hire' | 'finance' | 'reach';

export type Surface = ProductKey | 'tuah';

export type WeatherCondition = 'clear' | 'cloudy' | 'rain' | 'storm' | 'haze';

export type WeatherResult = {
  condition: WeatherCondition;
  hot: boolean;
  place: string | null;
};
