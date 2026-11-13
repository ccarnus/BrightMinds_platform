// The 26 departments are the OpenAlex "fields" (the virtual labs); `domain` is the OpenAlex domain
// above them: domain > field (lab) > subfield (area) > topic.
const DOMAINS = [
  { id: 1, name: 'Life Sciences' },
  { id: 2, name: 'Social Sciences' },
  { id: 3, name: 'Physical Sciences' },
  { id: 4, name: 'Health Sciences' },
];

const departments = [
  { id: 27, display_name: 'Medicine', domain: 4 },
  { id: 33, display_name: 'SocialSciences', domain: 2 },
  { id: 22, display_name: 'Engineering', domain: 3 },
  { id: 12, display_name: 'ArtsandHumanities', domain: 2 },
  { id: 17, display_name: 'ComputerScience', domain: 3 },
  { id: 13, display_name: 'BiochemistryGeneticsandMolecularBiology', domain: 1 },
  { id: 11, display_name: 'AgriculturalandBiologicalSciences', domain: 1 },
  { id: 23, display_name: 'EnvironmentalScience', domain: 3 },
  { id: 25, display_name: 'MaterialsScience', domain: 3 },
  { id: 31, display_name: 'PhysicsandAstronomy', domain: 3 },
  { id: 14, display_name: 'BusinessManagementandAccounting', domain: 2 },
  { id: 36, display_name: 'HealthProfessions', domain: 4 },
  { id: 20, display_name: 'EconomicsEconometricsandFinance', domain: 2 },
  { id: 32, display_name: 'Psychology', domain: 2 },
  { id: 16, display_name: 'Chemistry', domain: 3 },
  { id: 19, display_name: 'EarthandPlanetarySciences', domain: 3 },
  { id: 28, display_name: 'Neuroscience', domain: 1 },
  { id: 26, display_name: 'Mathematics', domain: 3 },
  { id: 24, display_name: 'ImmunologyandMicrobiology', domain: 1 },
  { id: 18, display_name: 'DecisionSciences', domain: 2 },
  { id: 21, display_name: 'Energy', domain: 3 },
  { id: 29, display_name: 'Nursing', domain: 4 },
  { id: 30, display_name: 'PharmacologyToxicologyandPharmaceutics', domain: 1 },
  { id: 35, display_name: 'Dentistry', domain: 4 },
  { id: 15, display_name: 'ChemicalEngineering', domain: 3 },
  { id: 34, display_name: 'Veterinary', domain: 4 },
];

const departmentNames = departments.map((department) => department.display_name);

const departmentIdByName = departments.reduce((acc, department) => {
  acc[department.display_name] = department.id;
  return acc;
}, {});

const departmentById = departments.reduce((acc, department) => {
  acc[department.id] = department;
  return acc;
}, {});

const domainById = DOMAINS.reduce((acc, domain) => {
  acc[domain.id] = domain;
  return acc;
}, {});

module.exports = {
  DOMAINS,
  departments,
  departmentNames,
  departmentIdByName,
  departmentById,
  domainById,
};
