// device-models.js - Traductor de Códigos de Fábrica a Nombres Comerciales de Celulares
// Mapea códigos como "23028RA60L" -> "Xiaomi Redmi 12" o "RMO-NX3" -> "Honor X8"

const MODEL_MAP = {
  // --- Xiaomi / Redmi / POCO ---
  '23028RA60L': 'Xiaomi Redmi 12 (4G)',
  '23076RN4BI': 'Xiaomi Redmi 12 5G',
  '23076RN8DY': 'Xiaomi Redmi 12 5G',
  '2201117TL':  'Xiaomi Redmi Note 11S',
  '2201117TY':  'Xiaomi Redmi Note 11S',
  '2201117PG':  'POCO M4 Pro',
  '2201116SG':  'Xiaomi Redmi Note 11 Pro 5G',
  '2201116SR':  'Xiaomi Redmi Note 11 Pro',
  '2201117TG':  'Xiaomi Redmi Note 11',
  '23129RAA4G': 'Xiaomi Redmi Note 13',
  '23124RA7EO': 'Xiaomi Redmi Note 13 4G',
  '23117RA68G': 'Xiaomi Redmi Note 13 Pro 5G',
  '23090RA98G': 'Xiaomi Redmi Note 13 Pro+ 5G',
  '23108RN04Y': 'Xiaomi Redmi 13C',
  '2212ARNC4L': 'Xiaomi Redmi 12C',
  '220733SL':   'Xiaomi Redmi A1',
  '23028RN4DG': 'Xiaomi Redmi A2',
  '2404ARN45A': 'Xiaomi Redmi A3',
  'M2101K6G':   'Xiaomi Redmi Note 10 Pro',
  'M2101K6R':   'Xiaomi Redmi Note 10 Pro',
  'M2101K7BN':  'Xiaomi Redmi Note 10S',
  'M2101K9G':   'Xiaomi Mi 11 Lite',
  'M2010J19SL': 'Xiaomi Redmi 9T',
  'M2010J19SG': 'Xiaomi Redmi 9T',
  'M2004J19G':  'Xiaomi Redmi 9',
  'M2006C3MNG': 'Xiaomi Redmi 9C',
  'M2006C3LG':  'Xiaomi Redmi 9A',
  '2109119DG':  'Xiaomi 11 Lite 5G NE',
  '22101320G':  'POCO X5 Pro 5G',
  '23122PCD1G': 'POCO X6 Pro 5G',
  '22011211G':  'POCO F4',
  '23049PCD8G': 'POCO F5',

  // --- Honor ---
  'RMO-NX3': 'Honor X8',
  'RMO-NX1': 'Honor X8 5G',
  'ANY-NX1': 'Honor 50 Lite',
  'WND-LX1': 'Honor X7',
  'CRT-LX3': 'Honor X7a',
  'CMA-LX3': 'Honor X8a',
  'ALI-NX1': 'Honor X9b',
  'ANY-LX1': 'Honor 50',
  'ANY-LX2': 'Honor 50',
  'FNE-NX9': 'Honor 70',
  'REA-NX9': 'Honor 90',
  'ELI-NX9': 'Honor 90 Lite',
  'BRP-NX1': 'Honor 200 Lite',

  // --- Samsung Galaxy ---
  'SM-A032M': 'Samsung Galaxy A03 Core',
  'SM-A035M': 'Samsung Galaxy A03',
  'SM-A042M': 'Samsung Galaxy A04e',
  'SM-A045M': 'Samsung Galaxy A04',
  'SM-A055M': 'Samsung Galaxy A05',
  'SM-A057M': 'Samsung Galaxy A05s',
  'SM-A125M': 'Samsung Galaxy A12',
  'SM-A127M': 'Samsung Galaxy A12 Nacho',
  'SM-A135M': 'Samsung Galaxy A13',
  'SM-A137F': 'Samsung Galaxy A13',
  'SM-A145M': 'Samsung Galaxy A14',
  'SM-A146M': 'Samsung Galaxy A14 5G',
  'SM-A155M': 'Samsung Galaxy A15',
  'SM-A156M': 'Samsung Galaxy A15 5G',
  'SM-A225M': 'Samsung Galaxy A22',
  'SM-A235M': 'Samsung Galaxy A23',
  'SM-A236M': 'Samsung Galaxy A23 5G',
  'SM-A245M': 'Samsung Galaxy A24',
  'SM-A256E': 'Samsung Galaxy A25 5G',
  'SM-A325M': 'Samsung Galaxy A32',
  'SM-A336M': 'Samsung Galaxy A33 5G',
  'SM-A346M': 'Samsung Galaxy A34 5G',
  'SM-A356E': 'Samsung Galaxy A35 5G',
  'SM-A515F': 'Samsung Galaxy A51',
  'SM-A525M': 'Samsung Galaxy A52',
  'SM-A526B': 'Samsung Galaxy A52 5G',
  'SM-A528B': 'Samsung Galaxy A52s 5G',
  'SM-A536B': 'Samsung Galaxy A53 5G',
  'SM-A536M': 'Samsung Galaxy A53 5G',
  'SM-A546E': 'Samsung Galaxy A54 5G',
  'SM-A546B': 'Samsung Galaxy A54 5G',
  'SM-A556B': 'Samsung Galaxy A55 5G',
  'SM-A556E': 'Samsung Galaxy A55 5G',
  'SM-G780G': 'Samsung Galaxy S20 FE',
  'SM-G781B': 'Samsung Galaxy S20 FE 5G',
  'SM-G990B': 'Samsung Galaxy S21 FE 5G',
  'SM-G991B': 'Samsung Galaxy S21 5G',
  'SM-S901B': 'Samsung Galaxy S22',
  'SM-S906B': 'Samsung Galaxy S22+',
  'SM-S908B': 'Samsung Galaxy S22 Ultra',
  'SM-S911B': 'Samsung Galaxy S23',
  'SM-S916B': 'Samsung Galaxy S23+',
  'SM-S918B': 'Samsung Galaxy S23 Ultra',
  'SM-S921B': 'Samsung Galaxy S24',
  'SM-S926B': 'Samsung Galaxy S24+',
  'SM-S928B': 'Samsung Galaxy S24 Ultra',
  'SM-S931B': 'Samsung Galaxy S25',
  'SM-S936B': 'Samsung Galaxy S25+',
  'SM-S938B': 'Samsung Galaxy S25 Ultra',

  // --- Motorola ---
  'XT2135-1': 'Motorola Moto G60',
  'XT2135-2': 'Motorola Moto G60',
  'XT2147-1': 'Motorola Moto G31',
  'XT2225-1': 'Motorola Moto G52',
  'XT2235-1': 'Motorola Moto G22',
  'XT2235-2': 'Motorola Moto G22',
  'XT2335-2': 'Motorola Moto G13',
  'XT2341-2': 'Motorola Moto G23',
  'XT2343-1': 'Motorola Moto G54 5G',
  'XT2345-2': 'Motorola Moto G84 5G',
  'XT2423-1': 'Motorola Moto G04',
  'XT2427-1': 'Motorola Moto G24',
  'XT2083-1': 'Motorola Moto E7',
  'XT2155-1': 'Motorola Moto E20',
  'XT2255-1': 'Motorola Moto E32',
  'XT2097-12': 'Motorola Moto E7i Power',

  // --- Oppo & Realme ---
  'CPH2269': 'Oppo A16',
  'CPH2387': 'Oppo A57',
  'CPH2477': 'Oppo A17',
  'CPH2579': 'Oppo A78',
  'RMX3263': 'Realme C21Y',
  'RMX3511': 'Realme C35',
  'RMX3710': 'Realme C55',
  'RMX3760': 'Realme C53',

  // --- Vivo ---
  'V2111':  'Vivo Y21',
  'V2204':  'Vivo Y22',
  'V2310':  'Vivo Y27',
  'V2144':  'Vivo Y33s',

  // --- Infinix & Tecno ---
  'X669':   'Infinix Hot 30i',
  'X6831':  'Infinix Hot 30',
  'X6833B': 'Infinix Note 30',
  'X6525':  'Infinix Smart 8',
  'X6515':  'Infinix Smart 7',
  'CK6n':   'Tecno Camon 20',
  'BG6':    'Tecno Spark 20',
  'KL5k':   'Tecno Spark 20 Pro',
  'BF7':    'Tecno Pop 7',
  'BG7':    'Tecno Pop 8'
};

function resolveDeviceModel(rawString, userFriendlyName) {
  if (!rawString || typeof rawString !== 'string') return userFriendlyName || 'Android';

  const clean = rawString.trim();

  // Si ya nos enviaron un nombre amigable válido (ej: "Redmi 12", "Honor X8")
  if (userFriendlyName && userFriendlyName.length > 2 && !/^[0-9A-Z_-]+$/.test(userFriendlyName)) {
    return userFriendlyName;
  }

  // Buscar coincidencia exacta en el diccionario
  for (const [code, commercial] of Object.entries(MODEL_MAP)) {
    if (clean.toUpperCase().includes(code.toUpperCase())) {
      return commercial;
    }
  }

  // Si no coincide con un código específico pero tiene marca conocida
  if (/^SM-[A-Z0-9]+/i.test(clean)) {
    return `Samsung Galaxy (${clean})`;
  }
  if (/^XT[0-9-]+/i.test(clean)) {
    return `Motorola Moto (${clean})`;
  }
  if (/^CPH[0-9]+/i.test(clean)) {
    return `Oppo (${clean})`;
  }
  if (/^RMX[0-9]+/i.test(clean)) {
    return `Realme (${clean})`;
  }

  // Devolver el modelo limpio
  return clean;
}

module.exports = {
  MODEL_MAP,
  resolveDeviceModel
};
